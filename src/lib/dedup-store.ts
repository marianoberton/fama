/**
 * Inbound webhook deduplication store.
 *
 * Chatwoot may retransmit the same `message_created` event (timeout / retry
 * on its side). Without dedupe, FAMA would post the reply twice. Hook lives
 * in the webhook handler right after the 6 filter rules and before any
 * side-effecting logic (NURTURING recordInbound, welcome, agent invocation).
 *
 * Why before `recordInbound` specifically: a transport-level retransmit is
 * not a "live client" — it must not reset NURTURING's retry_count or push
 * last_inbound_at forward, otherwise a Chatwoot retry would silently cancel
 * a follow-up cycle that was about to fire.
 *
 * Atomicity: `tryMarkProcessed` uses INSERT OR IGNORE on a UNIQUE PK so two
 * concurrent webhook posts with the same message_id can't both pass.
 *
 * Lives in the same LibSQL DB as Mastra Memory + NURTURING (one connection
 * per process, one volume).
 */

import { createClient, type Client } from '@libsql/client';
import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id    INTEGER PRIMARY KEY,
  processed_at  INTEGER NOT NULL
);
`;

let cachedClient: Client | undefined;

export async function getDedupStoreClient(): Promise<Client> {
  if (cachedClient) return cachedClient;
  const url = loadEnv().MASTRA_DB_URL;
  const client = createClient({ url });
  await client.execute(SCHEMA_SQL);
  cachedClient = client;
  return client;
}

/** Test-only: install a custom client (e.g. :memory:) and ensure schema exists. */
export async function setDedupStoreClientForTests(client: Client): Promise<void> {
  await client.execute(SCHEMA_SQL);
  cachedClient = client;
}

/** Test-only: drop the cached client so the next call re-reads loadEnv(). */
export function resetDedupStoreForTests(): void {
  cachedClient = undefined;
}

/** Run the schema migration explicitly. Idempotent. */
export async function initDedupTable(): Promise<void> {
  await getDedupStoreClient();
}

/**
 * Atomically claim `messageId`. Returns true if this call inserted the row
 * (i.e. the message is new and the caller should process it), false if a
 * prior call already inserted it (duplicate — caller must skip).
 *
 * Uses INSERT OR IGNORE so two concurrent calls with the same id resolve to
 * exactly one winner regardless of interleaving.
 */
export async function tryMarkProcessed(
  messageId: number,
  now: number = Date.now(),
): Promise<boolean> {
  const client = await getDedupStoreClient();
  const rs = await client.execute({
    sql: `INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?);`,
    args: [messageId, now],
  });
  return rs.rowsAffected === 1;
}

/**
 * Delete entries older than `ttlMs`. Returns the number of rows deleted.
 * Called periodically by the cleanup worker.
 */
export async function cleanupOldEntries(
  ttlMs: number,
  now: number = Date.now(),
): Promise<number> {
  const client = await getDedupStoreClient();
  const cutoff = now - ttlMs;
  const rs = await client.execute({
    sql: `DELETE FROM processed_messages WHERE processed_at < ?;`,
    args: [cutoff],
  });
  const deleted = rs.rowsAffected;
  if (deleted > 0) {
    logger.info({ deleted, cutoff }, 'dedup: cleaned old entries');
  }
  return deleted;
}

/** Test-only: wipe the table. */
export async function _truncateForTests(): Promise<void> {
  const client = await getDedupStoreClient();
  await client.execute('DELETE FROM processed_messages;');
}
