import { filterWebhook } from './filter.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';

export interface HandlerOutcome {
  status: 200 | 202 | 401;
  body: Record<string, unknown>;
}

export async function handleChatwootWebhook(input: {
  pathToken: string | undefined;
  rawBody: string;
}): Promise<HandlerOutcome> {
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

  // TODO Day 2: invoke recepcionista agent and post reply back to Chatwoot.
  // const agent = mastra.getAgent('recepcionista');
  // const reply = await agent.generate(...);
  // await postChatwootMessage(conversationId, reply.text);
  logger.info('webhook accepted; agent invocation pending Day 2');
  return { status: 202, body: { received: true } };
}
