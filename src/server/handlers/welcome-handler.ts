import { shouldSendHardcodedWelcome, WELCOME_TEXT } from '../../lib/welcome.js';
import { sendChatwootMessage, ChatwootNotConfiguredError } from '../../lib/chatwoot.js';
import { recordOutbound } from '../../lib/nurturing-store.js';
import { logger } from '../../lib/logger.js';
import type { HandlerOutcome } from './response-formatter.js';

/**
 * Hard-coded welcome path: if this is a short first-turn message from an
 * unknown customer with no media, post a fixed greeting and skip the LLM.
 *
 * Returns `{ handled: true, outcome }` when it took over; `{ handled: false }`
 * when the caller should continue to the LLM path.
 */
export async function handleWelcomePath(input: {
  conversationId: number;
  effectiveContent: string;
  isFirstTurn: boolean;
  knownContext: string | null;
  hasMedia: boolean;
}): Promise<{ handled: boolean; outcome?: HandlerOutcome }> {
  const { conversationId, effectiveContent, isFirstTurn, knownContext, hasMedia } = input;

  // Known customer, media present, or long message all route to the LLM.
  if (
    knownContext !== null ||
    hasMedia ||
    !shouldSendHardcodedWelcome({ text: effectiveContent, isFirstTurn })
  ) {
    return { handled: false };
  }

  logger.info(
    { conversationId, words: effectiveContent.trim().split(/\s+/).length },
    'webhook: short first turn → posting hard-coded welcome (no LLM)',
  );

  try {
    await sendChatwootMessage({ conversationId, content: WELCOME_TEXT });
    await recordOutbound({ conversationId }).catch((err) => {
      logger.error(
        { err: (err as Error).message, conversationId },
        'nurturing: recordOutbound (welcome) failed',
      );
    });
  } catch (err) {
    if (err instanceof ChatwootNotConfiguredError) {
      logger.warn(
        { conversationId },
        'CHATWOOT_API_TOKEN not configured — welcome NOT sent (dev/Studio mode)',
      );
    } else {
      logger.error(
        { err: (err as Error).message, conversationId },
        'webhook: hard-coded welcome post failed',
      );
      return { handled: true, outcome: { status: 500, body: { error: 'agent_or_post_failed' } } };
    }
  }

  return { handled: true, outcome: { status: 202, body: { received: true, welcome: true } } };
}
