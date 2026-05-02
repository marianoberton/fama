import type { Mastra } from '@mastra/core';
import { filterWebhook } from './filter.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sendChatwootMessage, ChatwootNotConfiguredError } from '../lib/chatwoot.js';

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

  // Native Mastra supervisor delegation: recepcionista decides when to call
  // the backoffice subagent based on its description + instructions.
  try {
    const recepcionista = input.mastra.getAgent('recepcionista');
    const reply = await recepcionista.generate(message.content, {
      memory: {
        thread: `chatwoot-${message.conversationId}`,
        resource: `contact-${message.contactId}`,
      },
      maxSteps: 8,
    });

    logger.info(
      {
        conversationId: message.conversationId,
        contactId: message.contactId,
        textLength: reply.text.length,
        steps: reply.steps?.length ?? 0,
      },
      'recepcionista responded',
    );

    try {
      await sendChatwootMessage({
        conversationId: message.conversationId,
        content: reply.text,
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

  const content = typeof msg['content'] === 'string' ? msg['content'] : null;

  const sender = isObject(msg['sender']) ? msg['sender'] : null;
  const contactId = sender && typeof sender['id'] === 'number' ? sender['id'] : null;

  if (conversationId === null || contactId === null || content === null) return null;
  return { conversationId, contactId, content };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
