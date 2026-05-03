import type { Mastra } from '@mastra/core';
import { filterWebhook } from './filter.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  sendChatwootMessage,
  getContactConversations,
  ChatwootNotConfiguredError,
} from '../lib/chatwoot.js';
import {
  recordInbound,
  recordOutbound,
  getConversation,
} from '../lib/nurturing-store.js';
import { tryMarkProcessed } from '../lib/dedup-store.js';
import { shouldSendHardcodedWelcome, WELCOME_TEXT } from '../lib/welcome.js';
import {
  detectKnownCustomer,
  formatKnownCustomerContext,
} from '../lib/known-customer.js';

export interface HandlerOutcome {
  status: 200 | 202 | 401 | 500;
  body: Record<string, unknown>;
}

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
    return { status: 401, body: { error: 'invalid_body_shape' } };
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
      return { status: 401, body: { error: result.reason } };
    }
    logger.debug({ reason: result.reason }, 'webhook ignored');
    return { status: 200, body: { ignored: result.reason } };
  }

  const message = extractMessage(body);
  if (!message) {
    logger.error('filter passed but message extraction failed');
    return { status: 500, body: { error: 'message_extraction_failed' } };
  }

  // Dedupe: Chatwoot may retransmit the same message_created event on retry.
  // We claim the message_id atomically before any side-effect (NURTURING
  // recordInbound, welcome post, agent invocation) so a duplicate is a no-op.
  // Fail-open: a dedup-store error logs and proceeds — better one duplicate
  // reply than a stuck inbox.
  try {
    const isNew = await tryMarkProcessed(message.messageId);
    if (!isNew) {
      logger.info(
        {
          messageId: message.messageId,
          conversationId: message.conversationId,
        },
        'webhook: duplicate message skipped',
      );
      return { status: 200, body: { ignored: 'duplicate_message' } };
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, messageId: message.messageId },
      'dedup: tryMarkProcessed failed — proceeding without dedupe',
    );
  }

  // Track for NURTURING. Resets retry counter — a fresh inbound means the
  // client is alive, so any pending follow-up cycle restarts from zero.
  // We capture the row BEFORE recordInbound so we know if this is the first
  // turn (no previous outbound).
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
  }).catch((err) => {
    logger.error(
      { err: (err as Error).message, conversationId: message.conversationId },
      'nurturing: recordInbound failed — continuing webhook processing',
    );
  });

  // Known-customer detection: only meaningful on the first turn (otherwise
  // we already replied in this thread and welcome / context is moot).
  // Fail closed: any error → treat as unknown and proceed normally.
  let knownContext: string | null = null;
  if (isFirstTurn) {
    try {
      const conversations = await getContactConversations({
        contactId: message.contactId,
      });
      const now = Date.now();
      const signal = detectKnownCustomer({
        conversations,
        now,
        inboxId: env.CHATWOOT_INBOX_ID,
        excludeConversationId: message.conversationId,
      });
      if (signal.known) {
        knownContext = formatKnownCustomerContext({ signal, now });
        logger.info(
          {
            conversationId: message.conversationId,
            contactId: message.contactId,
            priorCount: signal.count,
            lastConversationAt: signal.lastConversationAt,
          },
          'known-customer: detected — skipping welcome, injecting context to LLM',
        );
      } else {
        logger.info(
          {
            conversationId: message.conversationId,
            contactId: message.contactId,
            scanned: conversations.length,
          },
          'known-customer: not detected — first contact, normal flow',
        );
      }
    } catch (err) {
      logger.error(
        {
          err: (err as Error).message,
          conversationId: message.conversationId,
          contactId: message.contactId,
        },
        'known-customer: lookup failed — fail-closed, treating as not known',
      );
    }
  }

  // Hard-coded welcome path: short first message → fixed greeting, no LLM.
  // Skipped when the client is a known customer (we go straight to the LLM
  // with prior-context so the agent can greet them by their history).
  if (knownContext === null && shouldSendHardcodedWelcome({ text: message.content, isFirstTurn })) {
    logger.info(
      {
        conversationId: message.conversationId,
        words: message.content.trim().split(/\s+/).length,
      },
      'webhook: short first turn → posting hard-coded welcome (no LLM)',
    );
    try {
      await sendChatwootMessage({
        conversationId: message.conversationId,
        content: WELCOME_TEXT,
      });
      await recordOutbound({ conversationId: message.conversationId }).catch((err) => {
        logger.error(
          { err: (err as Error).message, conversationId: message.conversationId },
          'nurturing: recordOutbound (welcome) failed',
        );
      });
    } catch (err) {
      if (err instanceof ChatwootNotConfiguredError) {
        logger.warn(
          { conversationId: message.conversationId },
          'CHATWOOT_API_TOKEN not configured — welcome NOT sent (dev/Studio mode)',
        );
      } else {
        logger.error(
          { err: (err as Error).message, conversationId: message.conversationId },
          'webhook: hard-coded welcome post failed',
        );
        return { status: 500, body: { error: 'agent_or_post_failed' } };
      }
    }
    return { status: 202, body: { received: true, welcome: true } };
  }

  // Native Mastra supervisor delegation: recepcionista decides when to call
  // the backoffice subagent based on its description + instructions.
  try {
    const recepcionista = input.mastra.getAgent('recepcionista');
    const llmInput =
      knownContext !== null ? `${knownContext}\n\n${message.content}` : message.content;
    const reply = await recepcionista.generate(llmInput, {
      memory: {
        thread: `chatwoot-${message.conversationId}`,
        resource: `contact-${message.contactId}`,
      },
      maxSteps: 8,
    });

    const skipFinalPost = handoffAlreadyPostedAck(reply);

    logger.info(
      {
        conversationId: message.conversationId,
        contactId: message.contactId,
        textLength: reply.text.length,
        steps: reply.steps?.length ?? 0,
        skipFinalPost,
      },
      'recepcionista responded',
    );

    if (skipFinalPost) {
      // chatwoot-handoff already posted the public ack; skip the duplicate post.
      // The ack itself counts as outbound for NURTURING purposes.
      await recordOutbound({ conversationId: message.conversationId }).catch((err) => {
        logger.error(
          { err: (err as Error).message, conversationId: message.conversationId },
          'nurturing: recordOutbound (handoff ack) failed',
        );
      });
      return { status: 202, body: { received: true } };
    }

    try {
      await sendChatwootMessage({
        conversationId: message.conversationId,
        content: reply.text,
      });
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

  return { status: 202, body: { received: true } };
}

interface ExtractedMessage {
  messageId: number;
  conversationId: number;
  contactId: number;
  content: string;
}

function extractMessage(body: unknown): ExtractedMessage | null {
  if (!isObject(body)) return null;

  const conversation = body['conversation'];
  const conversationId = isObject(conversation) && typeof conversation['id'] === 'number'
    ? conversation['id']
    : null;

  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const msg = messages[0];
  if (!isObject(msg)) return null;

  const messageId = typeof msg['id'] === 'number' ? msg['id'] : null;
  const content = typeof msg['content'] === 'string' ? msg['content'] : null;

  const sender = isObject(msg['sender']) ? msg['sender'] : null;
  const contactId = sender && typeof sender['id'] === 'number' ? sender['id'] : null;

  if (
    messageId === null ||
    conversationId === null ||
    contactId === null ||
    content === null
  ) {
    return null;
  }
  return { messageId, conversationId, contactId, content };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns true if any tool in the agent's response — direct or nested via
 * sub-agent delegation — reported `replyHandled: true`. The chatwoot-handoff
 * tool sets this when it has posted the public ack, so we can skip posting
 * the supervisor's final text and avoid sending a duplicate message.
 */
function handoffAlreadyPostedAck(reply: unknown): boolean {
  function recurse(toolResults: unknown): boolean {
    if (!Array.isArray(toolResults)) return false;
    for (const tr of toolResults) {
      if (!isObject(tr)) continue;
      const payload = isObject(tr['payload']) ? tr['payload'] : null;
      const result = payload && isObject(payload['result']) ? payload['result'] : null;
      if (result && result['replyHandled'] === true) return true;
      if (result && recurse(result['subAgentToolResults'])) return true;
    }
    return false;
  }
  if (!isObject(reply)) return false;
  if (recurse(reply['toolResults'])) return true;
  const steps = reply['steps'];
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (isObject(step) && recurse(step['toolResults'])) return true;
    }
  }
  return false;
}
