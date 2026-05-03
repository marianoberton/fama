/**
 * NURTURING conversation tracker.
 *
 * Single LibSQL table, lives in the same DB as Mastra Memory (one connection,
 * one volume). The worker reads from here every 15 min to decide who needs a
 * follow-up. The webhook handler writes inbound/outbound timestamps. The
 * chatwoot-handoff tool writes the "escalated" status.
 *
 * Status lifecycle:
 *   pending → escalated   (handoff completed OR Chatwoot status flipped to `open`)
 *   pending → lost        (after 2 retries with no response)
 *   pending → pending     (client replied → recordInbound resets retryCount)
 */

import { createClient, type Client } from '@libsql/client';
import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

export type NurturingStatus = 'pending' | 'escalated' | 'lost';

export interface NurturingRow {
  conversationId: number;
  contactId: number;
  lastInboundAt: number; // epoch ms
  lastOutboundAt: number | null; // epoch ms or null
  retryCount: number; // 0, 1 or 2
  status: NurturingStatus;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nurturing_conversations (
  conversation_id   INTEGER PRIMARY KEY,
  contact_id        INTEGER NOT NULL,
  last_inbound_at   INTEGER NOT NULL,
  last_outbound_at  INTEGER,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending'
);
`;

let cachedClient: Client | undefined;

/**
 * Returns the singleton client. Creates it from MASTRA_DB_URL on first call
 * and runs the schema migration. Tests install a custom client (e.g. an
 * in-memory one) via `setNurturingStoreClientForTests` — once a client is
 * cached, it is reused regardless of env until `resetNurturingStoreForTests`
 * clears it.
 */
export async function getNurturingStoreClient(): Promise<Client> {
  if (cachedClient) return cachedClient;
  const url = loadEnv().MASTRA_DB_URL;
  const client = createClient({ url });
  await client.execute(SCHEMA_SQL);
  cachedClient = client;
  return client;
}

/** Test-only: install a custom client (e.g. :memory:) and ensure schema exists. */
export async function setNurturingStoreClientForTests(client: Client): Promise<void> {
  await client.execute(SCHEMA_SQL);
  cachedClient = client;
}

/** Test-only: drop the cached client so the next call re-reads loadEnv(). */
export function resetNurturingStoreForTests(): void {
  cachedClient = undefined;
}

function rowFromDb(r: Record<string, unknown>): NurturingRow {
  return {
    conversationId: Number(r['conversation_id']),
    contactId: Number(r['contact_id']),
    lastInboundAt: Number(r['last_inbound_at']),
    lastOutboundAt: r['last_outbound_at'] === null ? null : Number(r['last_outbound_at']),
    retryCount: Number(r['retry_count']),
    status: String(r['status']) as NurturingStatus,
  };
}

/**
 * Client sent a message. Reset retry counter and status — even if we'd already
 * fired a retry, the client is alive again and the cycle restarts.
 */
export async function recordInbound(input: {
  conversationId: number;
  contactId: number;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const client = await getNurturingStoreClient();
  await client.execute({
    sql: `
      INSERT INTO nurturing_conversations
        (conversation_id, contact_id, last_inbound_at, last_outbound_at, retry_count, status)
      VALUES (?, ?, ?, NULL, 0, 'pending')
      ON CONFLICT(conversation_id) DO UPDATE SET
        contact_id = excluded.contact_id,
        last_inbound_at = excluded.last_inbound_at,
        retry_count = 0,
        status = 'pending';
    `,
    args: [input.conversationId, input.contactId, now],
  });
}

/** Bot or human posted a message to the client. Updates last_outbound_at. */
export async function recordOutbound(input: {
  conversationId: number;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const client = await getNurturingStoreClient();
  await client.execute({
    sql: `
      UPDATE nurturing_conversations
      SET last_outbound_at = ?
      WHERE conversation_id = ?;
    `,
    args: [now, input.conversationId],
  });
}

/** Conversation went to a human — stop nurturing. */
export async function markEscalated(conversationId: number): Promise<void> {
  const client = await getNurturingStoreClient();
  await client.execute({
    sql: `
      UPDATE nurturing_conversations
      SET status = 'escalated'
      WHERE conversation_id = ?;
    `,
    args: [conversationId],
  });
}

/** 2 retries elapsed without response — stop nurturing and let the worker mark LOST in CRM. */
export async function markLost(conversationId: number): Promise<void> {
  const client = await getNurturingStoreClient();
  await client.execute({
    sql: `
      UPDATE nurturing_conversations
      SET status = 'lost'
      WHERE conversation_id = ?;
    `,
    args: [conversationId],
  });
}

/** Increment retry_count after sending a follow-up. */
export async function incrementRetry(input: {
  conversationId: number;
  newOutboundAt: number;
}): Promise<void> {
  const client = await getNurturingStoreClient();
  await client.execute({
    sql: `
      UPDATE nurturing_conversations
      SET retry_count = retry_count + 1,
          last_outbound_at = ?
      WHERE conversation_id = ?;
    `,
    args: [input.newOutboundAt, input.conversationId],
  });
}

export async function getConversation(
  conversationId: number,
): Promise<NurturingRow | null> {
  const client = await getNurturingStoreClient();
  const rs = await client.execute({
    sql: 'SELECT * FROM nurturing_conversations WHERE conversation_id = ?;',
    args: [conversationId],
  });
  if (rs.rows.length === 0) return null;
  return rowFromDb(rs.rows[0]! as unknown as Record<string, unknown>);
}

/**
 * Pre-select candidates: pending conversations whose last_inbound_at is at
 * least `minIdleMs` old. The worker re-evaluates the precise threshold per
 * row (4h vs 22h vs 24h), so we keep this query loose.
 */
export async function getPendingDue(input: {
  now?: number;
  minIdleMs?: number;
}): Promise<NurturingRow[]> {
  const now = input.now ?? Date.now();
  const minIdleMs = input.minIdleMs ?? 4 * 60 * 60 * 1000; // 4h default
  const client = await getNurturingStoreClient();
  const rs = await client.execute({
    sql: `
      SELECT * FROM nurturing_conversations
      WHERE status = 'pending'
        AND last_inbound_at <= ?
      ORDER BY last_inbound_at ASC;
    `,
    args: [now - minIdleMs],
  });
  return (rs.rows as unknown as Record<string, unknown>[]).map(rowFromDb);
}

/** Test-only: wipe the table. */
export async function _truncateForTests(): Promise<void> {
  const client = await getNurturingStoreClient();
  await client.execute('DELETE FROM nurturing_conversations;');
  logger.debug('nurturing_conversations truncated (tests)');
}
