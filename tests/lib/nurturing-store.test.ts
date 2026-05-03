import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_ID = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '7';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
});

const {
  setNurturingStoreClientForTests,
  recordInbound,
  recordOutbound,
  markEscalated,
  markLost,
  incrementRetry,
  getConversation,
  getPendingDue,
  _truncateForTests,
} = await import('../../src/lib/nurturing-store.js');

const T0 = Date.UTC(2026, 4, 4, 12, 0, 0); // 2026-05-04T12:00 UTC
const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  const client = createClient({ url: ':memory:' });
  await setNurturingStoreClientForTests(client);
  await _truncateForTests();
});

describe('nurturing-store', () => {
  it('recordInbound inserts a fresh row with retryCount=0 and status=pending', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });
    const row = await getConversation(100);
    expect(row).not.toBeNull();
    expect(row!.conversationId).toBe(100);
    expect(row!.contactId).toBe(91);
    expect(row!.lastInboundAt).toBe(T0);
    expect(row!.lastOutboundAt).toBeNull();
    expect(row!.retryCount).toBe(0);
    expect(row!.status).toBe('pending');
  });

  it('recordInbound on an existing row resets retryCount and status (client came back alive)', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });
    await incrementRetry({ conversationId: 100, newOutboundAt: T0 + HOUR });
    await markEscalated(100); // simulate human picked up

    // Client sends a fresh message later — cycle restarts.
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 + 5 * HOUR });
    const row = await getConversation(100);
    expect(row!.retryCount).toBe(0);
    expect(row!.status).toBe('pending');
    expect(row!.lastInboundAt).toBe(T0 + 5 * HOUR);
  });

  it('recordOutbound updates lastOutboundAt without touching retryCount', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });
    await recordOutbound({ conversationId: 100, now: T0 + HOUR });
    const row = await getConversation(100);
    expect(row!.lastOutboundAt).toBe(T0 + HOUR);
    expect(row!.retryCount).toBe(0);
  });

  it('incrementRetry bumps retryCount and updates lastOutboundAt atomically', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });
    await incrementRetry({ conversationId: 100, newOutboundAt: T0 + 4 * HOUR });
    let row = await getConversation(100);
    expect(row!.retryCount).toBe(1);
    expect(row!.lastOutboundAt).toBe(T0 + 4 * HOUR);

    await incrementRetry({ conversationId: 100, newOutboundAt: T0 + 22 * HOUR });
    row = await getConversation(100);
    expect(row!.retryCount).toBe(2);
    expect(row!.lastOutboundAt).toBe(T0 + 22 * HOUR);
  });

  it('markEscalated and markLost change status', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });
    await markEscalated(100);
    expect((await getConversation(100))!.status).toBe('escalated');

    await recordInbound({ conversationId: 200, contactId: 92, now: T0 });
    await markLost(200);
    expect((await getConversation(200))!.status).toBe('lost');
  });

  it('getPendingDue returns only pending rows older than minIdleMs, sorted oldest first', async () => {
    // 3 rows of varying age; one already escalated (must be excluded).
    await recordInbound({ conversationId: 100, contactId: 1, now: T0 - 5 * HOUR }); // 5h old, pending
    await recordInbound({ conversationId: 200, contactId: 2, now: T0 - 2 * HOUR }); // 2h old, pending → too fresh
    await recordInbound({ conversationId: 300, contactId: 3, now: T0 - 6 * HOUR }); // 6h old, escalated
    await markEscalated(300);

    const due = await getPendingDue({ now: T0, minIdleMs: 4 * HOUR });
    expect(due.map((r) => r.conversationId)).toEqual([100]);
  });

  it('getConversation returns null for unknown id', async () => {
    expect(await getConversation(99_999)).toBeNull();
  });
});
