/**
 * Hard-coded welcome path — when a fresh conversation opens with a short
 * message (< WELCOME_WORD_THRESHOLD words), we skip the LLM and post a fixed
 * Spanish greeting. Cheaper, faster, and deterministic for the most common
 * "Hola" / "Quiero info" first turn.
 *
 * The signal "is this the first turn?" comes from the nurturing store: a row
 * with `lastOutboundAt === null` means we have never replied in this thread.
 * Any subsequent inbound (even <30 words) goes through the LLM normally.
 *
 * Spec: fama-design-v1.md §4.
 */

export const WELCOME_WORD_THRESHOLD = 30;

export const WELCOME_TEXT = 'Hola, gracias por escribirnos a FOMO. ¿En qué puedo ayudarte?';

export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function shouldSendHardcodedWelcome(input: {
  text: string;
  isFirstTurn: boolean;
}): boolean {
  return input.isFirstTurn && wordCount(input.text) < WELCOME_WORD_THRESHOLD;
}
