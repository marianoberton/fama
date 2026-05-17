import { CircuitBreaker } from '../../lib/circuit-breaker.js';
import {
  sendChatwootMessage,
  addChatwootLabels,
  assignChatwootTeam,
  toggleChatwootStatus,
  ChatwootNotConfiguredError,
} from '../../lib/chatwoot.js';
import { logger } from '../../lib/logger.js';
import { loadEnv } from '../../config/env.js';
import type { HandlerOutcome } from './response-formatter.js';

// 3 consecutive LLM failures within 60s opens the circuit for 5 min.
// Exported so orchestration.test.ts can reset/inspect it.
export const llmCircuit = new CircuitBreaker({
  name: 'llm-recepcionista',
  failureThreshold: 3,
  failureWindowMs: 60_000,
  recoveryMs: 5 * 60_000,
});

const LLM_FALLBACK_MESSAGE =
  'Disculpá, en este momento tengo un problema técnico. Te paso con el equipo y te respondemos en cuanto podamos.';

/**
 * Fallback when the LLM circuit is open. Posts a fixed message to the customer
 * and escalates via Chatwoot low-level calls (not the chatwoot-handoff tool,
 * which requires LLM to formulate a reason).
 */
export async function runLlmCircuitFallback(input: {
  conversationId: number;
  env: ReturnType<typeof loadEnv>;
}): Promise<HandlerOutcome> {
  const { conversationId, env } = input;

  try {
    await sendChatwootMessage({ conversationId, content: LLM_FALLBACK_MESSAGE });
    logger.info({ conversationId }, 'webhook: posted LLM-fallback message to customer');
  } catch (err) {
    if (err instanceof ChatwootNotConfiguredError) {
      logger.warn(
        { conversationId },
        'webhook: LLM-fallback — Chatwoot not configured, message not sent',
      );
    } else {
      logger.error(
        { err: (err as Error).message, conversationId },
        'webhook: LLM-fallback message post failed',
      );
    }
  }

  // Escalate via low-level helpers: label + private note + team + flip status.
  try {
    await addChatwootLabels({ conversationId, labels: ['escalar-humano'] });
    await sendChatwootMessage({
      conversationId,
      content:
        '[LLM circuit abierto] El bot no pudo responder por fallo del LLM. Tomá la conversación manualmente.',
      private: true,
    });
    await assignChatwootTeam({ conversationId, teamId: env.CHATWOOT_TEAM_ID });
    await toggleChatwootStatus({ conversationId, status: 'open' });
    logger.info({ conversationId }, 'webhook: LLM-fallback escalation complete');
  } catch (err) {
    logger.error(
      { err: (err as Error).message, conversationId },
      'webhook: LLM-fallback escalation steps failed (continuing)',
    );
  }

  return { status: 202, body: { received: true, llmCircuitOpen: true } };
}
