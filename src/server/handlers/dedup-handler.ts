import { tryMarkProcessed } from '../../lib/dedup-store.js';
import { logger } from '../../lib/logger.js';

/**
 * Idempotency gate: marks the message as processed and returns whether it's a
 * duplicate. Fail-open: a store error logs and reports non-duplicate so the
 * conversation isn't silently dropped.
 */
export async function runDedupCheck(input: {
  messageId: number;
  conversationId: number;
}): Promise<{ isDuplicate: boolean }> {
  try {
    const isNew = await tryMarkProcessed(input.messageId);
    if (!isNew) {
      logger.info(
        { messageId: input.messageId, conversationId: input.conversationId },
        'webhook: duplicate message skipped',
      );
      return { isDuplicate: true };
    }
    return { isDuplicate: false };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, messageId: input.messageId },
      'dedup: tryMarkProcessed failed — proceeding without dedupe',
    );
    return { isDuplicate: false };
  }
}
