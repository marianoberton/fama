/**
 * Known-customer detection: pure function. Decides whether the contact
 * who just wrote in is "returning" — i.e. has at least one prior valid
 * conversation in the FAMA inbox within the last `windowDays` (default 30),
 * with at least `minMessages` (default 2) messages exchanged.
 *
 * Runs only on the first turn of a fresh conversation. When known, the webhook
 * handler skips the hard-coded welcome and injects context for the LLM so the
 * recepcionista can greet the client by their history instead of from scratch.
 *
 * The current conversation (the one whose webhook we're processing) is excluded
 * via `excludeConversationId` so a returning client whose new thread already
 * has 2+ messages on the Chatwoot side doesn't self-qualify.
 */

import type { ChatwootConversationSummary } from './chatwoot.js';

export interface KnownCustomerSignal {
  known: boolean;
  /** Number of valid prior conversations (only meaningful when known === true). */
  count: number;
  /** Epoch ms of the most recent prior conversation, or null when not known. */
  lastConversationAt: number | null;
}

export interface DetectInput {
  conversations: ChatwootConversationSummary[];
  now: number;
  inboxId: number;
  windowDays?: number;
  minMessages?: number;
  excludeConversationId?: number;
}

export function detectKnownCustomer(input: DetectInput): KnownCustomerSignal {
  const windowDays = input.windowDays ?? 30;
  const minMessages = input.minMessages ?? 2;
  const cutoff = input.now - windowDays * 24 * 60 * 60 * 1000;

  const valid = input.conversations.filter((c) => {
    if (input.excludeConversationId !== undefined && c.id === input.excludeConversationId) {
      return false;
    }
    if (c.inboxId !== input.inboxId) return false;
    if (c.messageCount < minMessages) return false;
    if (c.lastActivityAtMs < cutoff) return false;
    return true;
  });

  if (valid.length === 0) {
    return { known: false, count: 0, lastConversationAt: null };
  }

  const lastConversationAt = valid.reduce(
    (acc, c) => Math.max(acc, c.lastActivityAtMs),
    0,
  );
  return { known: true, count: valid.length, lastConversationAt };
}

/**
 * Builds the system-context block we prepend to the user's first message when
 * the customer is known. Marked with a clear sentinel so the recepcionista
 * recognises it as internal context (per its system prompt) and does not echo
 * it back to the user.
 */
export function formatKnownCustomerContext(input: {
  signal: KnownCustomerSignal;
  now: number;
}): string {
  if (!input.signal.known || input.signal.lastConversationAt === null) {
    throw new Error('formatKnownCustomerContext called with non-known signal');
  }
  const last = new Date(input.signal.lastConversationAt);
  const dateIso = last.toISOString().slice(0, 10);
  const daysAgo = Math.max(
    0,
    Math.floor((input.now - input.signal.lastConversationAt) / (24 * 60 * 60 * 1000)),
  );
  const daysLabel = daysAgo === 0 ? 'hoy' : daysAgo === 1 ? 'hace 1 día' : `hace ${daysAgo} días`;
  const convCount = input.signal.count;
  const convLabel = convCount === 1 ? '1 conversación previa' : `${convCount} conversaciones previas`;
  return [
    '[CONTEXTO_SISTEMA]',
    'Este es un cliente conocido.',
    `Conversaciones previas en los últimos 30 días: ${convLabel}.`,
    `Última conversación previa: ${dateIso} (${daysLabel}).`,
    '[/CONTEXTO_SISTEMA]',
  ].join('\n');
}
