import type { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/di';
import { filterWebhook } from './filter.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sendChatwootMessage, ChatwootNotConfiguredError } from '../lib/chatwoot.js';
import { recordInbound, recordOutbound, getConversation } from '../lib/nurturing-store.js';
import { trackBackground } from '../lib/background-tracker.js';
import { parseAttachments, type ChatwootRawAttachment } from '../lib/attachment-processor.js';
import {
  type HandlerOutcome,
  Responses,
  handoffAlreadyPostedAck,
} from './handlers/response-formatter.js';
import { runDedupCheck } from './handlers/dedup-handler.js';
import { resolveKnownCustomer } from './handlers/known-customer-handler.js';
import {
  processMessageAttachments,
  syncAttachmentsToTwenty,
} from './handlers/attachment-handler.js';
import { handleWelcomePath } from './handlers/welcome-handler.js';
import { llmCircuit, runLlmCircuitFallback } from './handlers/circuit-handler.js';

export type { HandlerOutcome };
// Re-exported so orchestration tests can inspect/reset the circuit.
export { llmCircuit };

export interface HandlerInput {
  pathToken: string | undefined;
  rawBody: string;
  mastra: Mastra;
}

export async function handleChatwootWebhook(input: HandlerInput): Promise<HandlerOutcome> {
  const env = loadEnv();

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'webhook body parse failed');
    return Responses.rejected('invalid_body_shape');
  }

  const result = filterWebhook({
    pathToken: input.pathToken ?? '',
    body,
    expectedAccountId: env.CHATWOOT_ACCOUNT_ID,
    expectedPathToken: env.CHATWOOT_PATH_TOKEN,
  });

  if (!result.pass) {
    if (result.status === 401) {
      logger.warn({ reason: result.reason }, 'webhook rejected');
      return Responses.rejected(result.reason);
    }
    logger.warn({ reason: result.reason }, 'webhook ignored');
    return Responses.ignored(result.reason);
  }

  const message = extractMessage(body);
  if (!message) {
    logger.error('filter passed but message extraction failed');
    return Responses.extractionFailed();
  }

  // Dedup runs synchronously before the 202 so a Chatwoot retry arriving while
  // we're still processing can't slip through the idempotency gate.
  const { isDuplicate } = await runDedupCheck({
    messageId: message.messageId,
    conversationId: message.conversationId,
  });
  if (isDuplicate) {
    return Responses.duplicate();
  }

  // Background processing: respond 202 immediately so Chatwoot doesn't
  // interpret a slow LLM call as a webhook failure and flip the conversation.
  const processing = processMessageBackground(input, message, env);
  if (env.NODE_ENV === 'test') {
    return await processing;
  }
  trackBackground(processing).catch((err) => {
    logger.error(
      { err: (err as Error).message, conversationId: message.conversationId },
      'webhook: background processing failed',
    );
  });
  return { status: 202, body: { received: true } };
}

// ---------------------------------------------------------------------------
// Background processing — everything after the 202 response.
// ---------------------------------------------------------------------------

async function processMessageBackground(
  input: HandlerInput,
  message: ExtractedMessage,
  env: ReturnType<typeof loadEnv>,
): Promise<HandlerOutcome> {
  // NURTURING: capture the row before recordInbound to detect first turn.
  const priorRow = await getConversation(message.conversationId).catch((err) => {
    logger.error(
      { err: (err as Error).message, conversationId: message.conversationId },
      'nurturing: getConversation failed — assuming not first turn (safer)',
    );
    return null;
  });
  const isFirstTurn = priorRow === null || priorRow.lastOutboundAt === null;

  await recordInbound({
    conversationId: message.conversationId,
    contactId: message.contactId,
    phone: message.contactPhone || null,
  }).catch((err) => {
    logger.error(
      { err: (err as Error).message, conversationId: message.conversationId },
      'nurturing: recordInbound failed — continuing webhook processing',
    );
  });

  // Known-customer detection only on first turn (subsequent turns already have
  // context in the LLM thread via Memory).
  let knownContext: string | null = null;
  if (isFirstTurn) {
    const kc = await resolveKnownCustomer({
      contactId: message.contactId,
      conversationId: message.conversationId,
      inboxIds: env.CHATWOOT_INBOX_IDS,
    });
    knownContext = kc.knownContext;
  }

  const { effectiveContent, processedAttachments, hasMedia } = await processMessageAttachments({
    originalContent: message.content,
    attachments: message.attachments,
    conversationId: message.conversationId,
  });

  const welcome = await handleWelcomePath({
    conversationId: message.conversationId,
    effectiveContent,
    isFirstTurn,
    knownContext,
    hasMedia,
  });
  if (welcome.handled) return welcome.outcome!;

  if (llmCircuit.isOpen()) {
    logger.warn(
      { conversationId: message.conversationId },
      'webhook: LLM circuit open — using fallback path (fixed message + escalate)',
    );
    return runLlmCircuitFallback({ conversationId: message.conversationId, env });
  }

  try {
    const recepcionista = input.mastra.getAgent('recepcionista');
    const llmInput =
      knownContext !== null ? `${knownContext}\n\n${effectiveContent}` : effectiveContent;

    const requestContext = new RequestContext();
    requestContext.set('conversationId', message.conversationId);
    requestContext.set('contactId', message.contactId);
    if (message.contactPhone) requestContext.set('phone', message.contactPhone);
    if (message.contactName) requestContext.set('contactName', message.contactName);
    // Langfuse session/user grouping (v4 Sprint 1).
    requestContext.set('sessionId', `chatwoot-${message.conversationId}`);
    requestContext.set('userId', `contact-${message.contactId}`);

    let reply;
    try {
      reply = await recepcionista.generate(llmInput, {
        memory: {
          thread: `chatwoot-${message.conversationId}`,
          resource: `contact-${message.contactId}`,
        },
        maxSteps: 8,
        requestContext,
      });
      llmCircuit.recordSuccess();
    } catch (err) {
      llmCircuit.recordFailure();
      throw err;
    }

    const skipFinalPost = handoffAlreadyPostedAck(reply);

    const allToolCalls = (reply.steps ?? []).flatMap((s: unknown) => {
      const step = s as Record<string, unknown>;
      return Array.isArray(step['toolCalls']) ? step['toolCalls'] : [];
    });

    logger.info(
      {
        conversationId: message.conversationId,
        contactId: message.contactId,
        textLength: reply.text.length,
        steps: reply.steps?.length ?? 0,
        skipFinalPost,
        toolCalls: allToolCalls.map((tc: unknown) => {
          const t = tc as Record<string, unknown>;
          return { tool: t['toolName'], args: t['args'] };
        }),
      },
      'recepcionista responded',
    );

    if (skipFinalPost) {
      // chatwoot-handoff already posted the public ack; skip the duplicate.
      await recordOutbound({ conversationId: message.conversationId }).catch((err) => {
        logger.error(
          { err: (err as Error).message, conversationId: message.conversationId },
          'nurturing: recordOutbound (handoff ack) failed',
        );
      });
      await syncAttachmentsToTwenty({
        processed: processedAttachments,
        phone: message.contactPhone,
        contactName: message.contactName,
        conversationId: message.conversationId,
        baseUrl: env.CHATWOOT_BASE_URL,
        accountId: env.CHATWOOT_ACCOUNT_ID,
      });
      return { status: 202, body: { received: true } };
    }

    try {
      await sendChatwootMessage({ conversationId: message.conversationId, content: reply.text });
      await recordOutbound({ conversationId: message.conversationId }).catch((err) => {
        logger.error(
          { err: (err as Error).message, conversationId: message.conversationId },
          'nurturing: recordOutbound failed (post succeeded)',
        );
      });
    } catch (err) {
      if (err instanceof ChatwootNotConfiguredError) {
        logger.warn(
          {
            conversationId: message.conversationId,
            replyPreview: reply.text.slice(0, 200),
          },
          'CHATWOOT_API_TOKEN not configured — reply NOT sent (dev/Studio mode)',
        );
      } else {
        throw err;
      }
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, stack: (err as Error).stack },
      'agent invocation or chatwoot post failed',
    );
    return { status: 500, body: { error: 'agent_or_post_failed' } };
  }

  await syncAttachmentsToTwenty({
    processed: processedAttachments,
    phone: message.contactPhone,
    contactName: message.contactName,
    conversationId: message.conversationId,
    baseUrl: env.CHATWOOT_BASE_URL,
    accountId: env.CHATWOOT_ACCOUNT_ID,
  });
  return { status: 202, body: { received: true } };
}

// ---------------------------------------------------------------------------
// Message extraction — parses the Chatwoot webhook body into a typed struct.
// ---------------------------------------------------------------------------

interface ExtractedMessage {
  messageId: number;
  conversationId: number;
  contactId: number;
  content: string;
  /** WhatsApp profile name from sender. Empty string if missing. */
  contactName: string;
  /** E.164 phone (e.g. '+5491132766709'). Empty string if missing. */
  contactPhone: string;
  /** Raw Chatwoot attachments — empty array if none. Sprint 2. */
  attachments: ChatwootRawAttachment[];
}

function extractMessage(body: unknown): ExtractedMessage | null {
  if (!isObject(body)) return null;

  const conversation = body['conversation'];
  const conversationId =
    isObject(conversation) && typeof conversation['id'] === 'number'
      ? conversation['id']
      : null;

  // Chatwoot v4.12.1 nests messages inside `conversation.messages`. Older /
  // alternate shapes deliver them at the root — keep that as fallback.
  const nestedMessages =
    isObject(conversation) && Array.isArray(conversation['messages'])
      ? conversation['messages']
      : null;
  const rootMessages = Array.isArray(body['messages']) ? body['messages'] : null;
  const messages = nestedMessages ?? rootMessages ?? [];
  const msg = messages[0];
  if (!isObject(msg)) return null;

  const messageId = typeof msg['id'] === 'number' ? msg['id'] : null;
  // Media-only messages may have null content from Chatwoot; default to '' so
  // the attachment pre-processor downstream can fill it.
  const content = typeof msg['content'] === 'string' ? msg['content'] : '';

  const sender = isObject(msg['sender']) ? msg['sender'] : null;
  const contactId = sender && typeof sender['id'] === 'number' ? sender['id'] : null;
  const rootSender = isObject(body['sender']) ? body['sender'] : null;
  const contactName = pickString(sender?.['name']) ?? pickString(rootSender?.['name']) ?? '';
  const contactPhone =
    pickString(sender?.['phone_number']) ?? pickString(rootSender?.['phone_number']) ?? '';

  if (messageId === null || conversationId === null || contactId === null) return null;

  return {
    messageId,
    conversationId,
    contactId,
    content,
    contactName,
    contactPhone,
    attachments: parseAttachments(msg),
  };
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
