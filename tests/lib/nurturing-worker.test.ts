import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createClient } from '@libsql/client';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_ID = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '7';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
  process.env.CHATWOOT_API_TOKEN = 'test-api-token';
});

const {
  setNurturingStoreClientForTests,
  recordInbound,
  incrementRetry,
  getConversation,
  _truncateForTests,
} = await import('../../src/lib/nurturing-store.js');

const { startNurturingWorker } = await import('../../src/lib/nurturing-worker.js');

const HOUR = 60 * 60 * 1000;
// AR 14:00 on a weekday — comfortably inside business hours.
const T_BUSINESS = Date.UTC(2026, 4, 4, 17, 0, 0); // 17 UTC == 14 AR
// AR 03:00 — outside business hours.
const T_NIGHT = Date.UTC(2026, 4, 4, 6, 0, 0); // 6 UTC == 3 AR

const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  const client = createClient({ url: ':memory:' });
  await setNurturingStoreClientForTests(client);
  await _truncateForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function chatwootStatusResponse(status: string): Response {
  return new Response(JSON.stringify({ status }), { status: 200 });
}

function ok(): Response {
  return new Response(JSON.stringify({}), { status: 200 });
}

describe('nurturing worker tick', () => {
  it('sends retry 1 when retryCount=0 and idle >= 4h, inside business hours', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T_BUSINESS - 5 * HOUR });

    fetchMock
      .mockResolvedValueOnce(chatwootStatusResponse('pending')) // GET status
      .mockResolvedValueOnce(ok()); // POST follow-up message

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_BUSINESS });
    try {
      await w.tick(T_BUSINESS);
    } finally {
      w.stop();
    }

    const row = await getConversation(100);
    expect(row!.retryCount).toBe(1);
    expect(row!.status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sendCall = fetchMock.mock.calls[1]!;
    expect(String(sendCall[0])).toMatch(/conversations\/100\/messages$/);
  });

  it('skips and marks escalated when Chatwoot status is open', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T_BUSINESS - 5 * HOUR });

    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('open'));

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_BUSINESS });
    try {
      await w.tick(T_BUSINESS);
    } finally {
      w.stop();
    }

    const row = await getConversation(100);
    expect(row!.status).toBe('escalated');
    expect(row!.retryCount).toBe(0); // never sent
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET, no message POST
  });

  it('skips outbound when outside AR business hours but does not escalate', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T_NIGHT - 5 * HOUR });

    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_NIGHT });
    try {
      await w.tick(T_NIGHT);
    } finally {
      w.stop();
    }

    const row = await getConversation(100);
    expect(row!.status).toBe('pending');
    expect(row!.retryCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET
  });

  it('sends retry 2 when retryCount=1 and idle >= 22h, inside business hours', async () => {
    // Last inbound 23h ago, retry 1 already sent (retryCount=1).
    await recordInbound({ conversationId: 100, contactId: 91, now: T_BUSINESS - 23 * HOUR });
    await incrementRetry({ conversationId: 100, newOutboundAt: T_BUSINESS - 19 * HOUR });

    fetchMock
      .mockResolvedValueOnce(chatwootStatusResponse('pending'))
      .mockResolvedValueOnce(ok());

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_BUSINESS });
    try {
      await w.tick(T_BUSINESS);
    } finally {
      w.stop();
    }

    const row = await getConversation(100);
    expect(row!.retryCount).toBe(2);
    expect(row!.status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks LOST when retryCount=2 and idle >= 24h', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T_BUSINESS - 25 * HOUR });
    await incrementRetry({ conversationId: 100, newOutboundAt: T_BUSINESS - 21 * HOUR });
    await incrementRetry({ conversationId: 100, newOutboundAt: T_BUSINESS - 3 * HOUR });

    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_BUSINESS });
    try {
      await w.tick(T_BUSINESS);
    } finally {
      w.stop();
    }

    const row = await getConversation(100);
    expect(row!.status).toBe('lost');
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET, no follow-up POST
  });

  it('does nothing when no candidates are due (idle < 4h)', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T_BUSINESS - 1 * HOUR });

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_BUSINESS });
    try {
      await w.tick(T_BUSINESS);
    } finally {
      w.stop();
    }

    const row = await getConversation(100);
    expect(row!.retryCount).toBe(0);
    expect(row!.status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('skips rows already in escalated status (never enters the candidate set)', async () => {
    await recordInbound({ conversationId: 100, contactId: 91, now: T_BUSINESS - 10 * HOUR });
    const { markEscalated } = await import('../../src/lib/nurturing-store.js');
    await markEscalated(100);

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_BUSINESS });
    try {
      await w.tick(T_BUSINESS);
    } finally {
      w.stop();
    }

    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('does NOT send retry 2 once the 24h Meta window has closed (marks LOST instead)', async () => {
    // Cliente escribió hace 25h, ya recibió retry 1, está dentro de horario.
    // Antes del fix: se enviaba retry 2 (rompía la ventana Meta).
    // Después del fix: se marca LOST sin enviar.
    await recordInbound({ conversationId: 100, contactId: 91, now: T_BUSINESS - 25 * HOUR });
    await incrementRetry({ conversationId: 100, newOutboundAt: T_BUSINESS - 13 * HOUR });

    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));

    const w = startNurturingWorker({ intervalMs: 60_000, now: () => T_BUSINESS });
    try {
      await w.tick(T_BUSINESS);
    } finally {
      w.stop();
    }

    const row = await getConversation(100);
    expect(row!.status).toBe('lost');
    expect(row!.retryCount).toBe(1); // never bumped to 2 — retry 2 was skipped
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET, no follow-up POST
  });
});

/**
 * Three real-world scheduling scenarios that exercise the AR business-hours
 * filter together with the 24h Meta window cap. These exist because a previous
 * version of the worker did not cap retries at 24h, so a client who wrote at
 * 21:00 AR would have received a retry 2 at 36h — outside the Meta session
 * window. fama-design-v1.md §11 explicitly defers Meta templates to v2, so the
 * v1 trade-off is: clients who write outside business hours get only 1 retry.
 */
describe('nurturing scheduling scenarios (AR clock + 24h Meta cap)', () => {
  /** AR hour h on a given UTC day → epoch ms. AR is UTC-3, so AR h == UTC h+3. */
  function ar(arDay: number, arHour: number): number {
    return Date.UTC(2026, 4, arDay, arHour + 3, 0, 0);
  }

  it('Scenario A — client writes at 14:00 AR: retry 1 at 18:00, retry 2 at 12:00 next day, LOST at 14:00 next day', async () => {
    const T0 = ar(4, 14);
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });

    // Tick at 18:00 day 1 — idle 4h, business hours, retryCount=0 → send retry 1.
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending')).mockResolvedValueOnce(ok());
    let w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(4, 18) });
    try {
      await w.tick(ar(4, 18));
    } finally {
      w.stop();
    }
    let row = await getConversation(100);
    expect(row!.retryCount).toBe(1);
    expect(row!.status).toBe('pending');

    // Tick at 12:00 day 2 — idle 22h, business hours, retryCount=1 → send retry 2.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending')).mockResolvedValueOnce(ok());
    w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(5, 12) });
    try {
      await w.tick(ar(5, 12));
    } finally {
      w.stop();
    }
    row = await getConversation(100);
    expect(row!.retryCount).toBe(2);
    expect(row!.status).toBe('pending');

    // Tick at 14:00 day 2 — idle 24h, business hours → markLost.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));
    w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(5, 14) });
    try {
      await w.tick(ar(5, 14));
    } finally {
      w.stop();
    }
    row = await getConversation(100);
    expect(row!.status).toBe('lost');
  });

  it('Scenario B — client writes at 21:00 AR: skips overnight, retry 1 at 09:00, LOST at 21:00 next day (no retry 2)', async () => {
    const T0 = ar(4, 21);
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });

    // Tick at 03:00 day 2 — idle 6h, but outside business hours → skip (only GET).
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));
    let w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(5, 3) });
    try {
      await w.tick(ar(5, 3));
    } finally {
      w.stop();
    }
    let row = await getConversation(100);
    expect(row!.retryCount).toBe(0);
    expect(row!.status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only, no message send

    // Tick at 09:00 day 2 — idle 12h, business hours, retryCount=0 → retry 1.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending')).mockResolvedValueOnce(ok());
    w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(5, 9) });
    try {
      await w.tick(ar(5, 9));
    } finally {
      w.stop();
    }
    row = await getConversation(100);
    expect(row!.retryCount).toBe(1);
    expect(row!.status).toBe('pending');

    // Tick at 19:00 day 2 — idle 22h, retryCount=1 BUT outside business hours
    // (19:00 is exclusive). Should skip without sending retry 2.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));
    w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(5, 19) });
    try {
      await w.tick(ar(5, 19));
    } finally {
      w.stop();
    }
    row = await getConversation(100);
    expect(row!.retryCount).toBe(1); // still 1, retry 2 skipped
    expect(row!.status).toBe('pending');

    // Tick at 21:00 day 2 — idle 24h → markLost (without ever sending retry 2).
    // This is the v1 trade-off: client who wrote outside business hours gets 1 retry.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));
    w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(5, 21) });
    try {
      await w.tick(ar(5, 21));
    } finally {
      w.stop();
    }
    row = await getConversation(100);
    expect(row!.status).toBe('lost');
    expect(row!.retryCount).toBe(1); // confirms retry 2 was never sent
  });

  it('Scenario C — client writes at 03:00 AR: retry 1 at 09:00 same day, LOST at 03:00 next day (no retry 2)', async () => {
    const T0 = ar(4, 3);
    await recordInbound({ conversationId: 100, contactId: 91, now: T0 });

    // Tick at 07:00 day 1 — idle 4h, but outside business hours → skip.
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));
    let w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(4, 7) });
    try {
      await w.tick(ar(4, 7));
    } finally {
      w.stop();
    }
    let row = await getConversation(100);
    expect(row!.retryCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Tick at 09:00 day 1 — idle 6h, business hours → retry 1.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending')).mockResolvedValueOnce(ok());
    w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(4, 9) });
    try {
      await w.tick(ar(4, 9));
    } finally {
      w.stop();
    }
    row = await getConversation(100);
    expect(row!.retryCount).toBe(1);

    // Tick at 03:00 day 2 — idle 24h → markLost (retry 2 was never possible
    // because it would have fallen at 01:00, outside business hours).
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(chatwootStatusResponse('pending'));
    w = startNurturingWorker({ intervalMs: 60_000, now: () => ar(5, 3) });
    try {
      await w.tick(ar(5, 3));
    } finally {
      w.stop();
    }
    row = await getConversation(100);
    expect(row!.status).toBe('lost');
    expect(row!.retryCount).toBe(1); // only 1 retry sent — v1 trade-off
  });
});
