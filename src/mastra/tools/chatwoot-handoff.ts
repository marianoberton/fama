import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  CHATWOOT_VALID_LABELS,
  type ChatwootLabel,
} from '../../config/chatwoot-labels.js';
import { loadEnv } from '../../config/env.js';
import {
  sendChatwootMessage,
  addChatwootLabels,
  assignChatwootTeam,
  toggleChatwootStatus,
  ChatwootApiError,
  ChatwootNotConfiguredError,
} from '../../lib/chatwoot.js';
import { markEscalated } from '../../lib/nurturing-store.js';
import { logger } from '../../lib/logger.js';

/**
 * chatwoot-handoff — escala una conversación a un humano del equipo.
 *
 * Orden de llamadas (CLAUDE.md exige "ack antes del toggle_status", así que
 * ack es paso 0; los 4 pasos canónicos siguen como 1-4):
 *
 *   0. POST .../messages  body: { content: ackMessage, message_type:'outgoing', private:false }
 *   1. POST .../labels    body: { labels: [category] }
 *   2. POST .../messages  body: { content: reason, message_type:'outgoing', private:true }
 *   3. POST .../assignments body: { team_id: CHATWOOT_TEAM_ID }
 *   4. POST .../toggle_status body: { status: 'open' }
 *
 * Idempotencia: lock en memoria por conversationId. Si la misma conversación
 * se handoffeó en los últimos 60s, retornamos no-op exitoso (idempotentSkip).
 *
 * replyHandled: true cuando posteamos el ack (paso 0). El webhook handler usa
 * esto para no duplicar el mensaje al usuario con el texto final del agente.
 */

const HANDOFF_LOCK_MS = 60_000;
const handoffLocks = new Map<number, number>();

/** Exposed for tests — clears the in-memory idempotency lock. */
export function _resetHandoffLockForTests(): void {
  handoffLocks.clear();
}

function tryAcquireHandoffLock(conversationId: number): boolean {
  const now = Date.now();
  const expiry = handoffLocks.get(conversationId);
  if (expiry !== undefined && expiry > now) return false;
  handoffLocks.set(conversationId, now + HANDOFF_LOCK_MS);
  return true;
}

const stepFailedSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.null(),
]);

export interface HandoffInput {
  conversationId: number;
  category: ChatwootLabel;
  ackMessage: string;
  reason: string;
}

export interface HandoffOutput {
  success: boolean;
  step_failed: 0 | 1 | 2 | 3 | 4 | null;
  error?: string;
  replyHandled: boolean;
  idempotentSkip?: boolean;
}

/**
 * Pure(-ish) implementation of the handoff sequence, exported for tests.
 * createTool's execute is a thin wrapper that schema-validates and delegates here.
 */
export async function runHandoff(input: HandoffInput): Promise<HandoffOutput> {
  const { conversationId, category, ackMessage, reason } = input;

  if (!tryAcquireHandoffLock(conversationId)) {
    logger.warn(
      { conversationId, category },
      'chatwoot-handoff idempotent skip — lock held within 60s window',
    );
    return {
      success: true,
      step_failed: null,
      replyHandled: true,
      idempotentSkip: true,
    };
  }

  const env = loadEnv();
  let step: 0 | 1 | 2 | 3 | 4 = 0;

  try {
    // Step 0 — public ack (CLAUDE.md: "antes del toggle_status").
    step = 0;
    await sendChatwootMessage({
      conversationId,
      content: ackMessage,
      private: false,
    });

    // Step 1 — apply label.
    step = 1;
    await addChatwootLabels({ conversationId, labels: [category] });

    // Step 2 — private note with the formatted handoff context.
    step = 2;
    await sendChatwootMessage({
      conversationId,
      content: reason,
      private: true,
    });

    // Step 3 — assign the team.
    step = 3;
    await assignChatwootTeam({
      conversationId,
      teamId: env.CHATWOOT_TEAM_ID,
    });

    // Step 4 — flip status to open so a human picks it up.
    step = 4;
    await toggleChatwootStatus({ conversationId, status: 'open' });

    // Stop the NURTURING loop — a human is taking over.
    await markEscalated(conversationId).catch((err) => {
      logger.error(
        { conversationId, err: (err as Error).message },
        'nurturing: markEscalated failed (handoff already completed OK)',
      );
    });

    logger.info(
      { conversationId, category },
      'chatwoot-handoff completed all 5 steps',
    );

    return {
      success: true,
      step_failed: null,
      replyHandled: true,
    };
  } catch (err) {
    // Release the lock so a retry can run again.
    handoffLocks.delete(conversationId);

    const errMsg =
      err instanceof ChatwootApiError
        ? err.message
        : err instanceof ChatwootNotConfiguredError
          ? err.message
          : (err as Error).message;

    logger.error(
      { conversationId, category, step_failed: step, err: errMsg },
      'chatwoot-handoff failed',
    );

    // If step 0 (ack) failed, the user got nothing — replyHandled stays false
    // so the webhook handler can still post the agent's text as a fallback.
    return {
      success: false,
      step_failed: step,
      error: errMsg,
      replyHandled: step > 0,
    };
  }
}

export const chatwootHandoff = createTool({
  id: 'chatwoot-handoff',
  description:
    'Escala la conversación de Chatwoot a un humano del equipo: postea un ack público al cliente (paso 0), aplica label, deja nota privada con contexto, asigna al team y abre la conversación. Usar cuando el cliente pide hablar con persona, hay urgencia/reclamo, o se cerró una venta y hay que pasarla al humano. El ack y la categoría son obligatorios.',
  inputSchema: z.object({
    category: z
      .enum(CHATWOOT_VALID_LABELS)
      .describe('Label de Chatwoot. Sólo valores de CHATWOOT_VALID_LABELS.'),
    ackMessage: z
      .string()
      .min(1)
      .describe(
        'Mensaje público breve para el cliente, posteado ANTES del toggle_status (ej: "Te paso con un asesor, te respondemos a la brevedad").',
      ),
    reason: z
      .string()
      .min(1)
      .describe(
        'Texto de la nota privada con el contexto, formateado per template de CLAUDE.md (Categoría / Motivo / Cliente / Empresa / Datos clave).',
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    step_failed: stepFailedSchema,
    error: z.string().optional(),
    replyHandled: z.boolean(),
    idempotentSkip: z.boolean().optional(),
  }),
  // conversationId comes from RequestContext (set by webhook handler), NOT from
  // the LLM. This prevents hallucinated IDs from Studio chats or partial prompts.
  execute: async (input, context) => {
    const conversationId = context?.requestContext?.get('conversationId');
    if (typeof conversationId !== 'number') {
      throw new Error(
        'chatwoot-handoff: conversationId missing from requestContext — only callable inside the webhook flow',
      );
    }
    return runHandoff({ ...input, conversationId });
  },
});
