import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_ID = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '1';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
  process.env.CHATWOOT_API_TOKEN = 'test-api-token';
});

const { startAutoHandbackWorker } = await import('../../src/lib/auto-handback-worker.js');

const MINUTE = 60 * 1000;
const NOW = Date.UTC(2026, 4, 12, 15, 0, 0); // fixed clock for all tests

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openConversationsResponse(
  conversations: Array<{ id: number; lastActivityAtMs: number }>,
): Response {
  // Chatwoot conversations list wraps in data.payload
  const payload = conversations.map((c) => ({
    id: c.id,
    inbox_id: 3,
    messages_count: 5,
    // epoch seconds (Chatwoot stores seconds, not ms)
    last_activity_at: Math.floor(c.lastActivityAtMs / 1000),
  }));
  return new Response(JSON.stringify({ data: { payload } }), { status: 200 });
}

function ok(): Response {
  return new Response(JSON.stringify({}), { status: 200 });
}

describe('auto-handback worker tick', () => {
  it('flips idle open conversation to pending when idle > threshold', async () => {
    const idleMs = 35 * MINUTE; // 35 min > default 30 min threshold

    fetchMock
      .mockResolvedValueOnce(openConversationsResponse([{ id: 42, lastActivityAtMs: NOW - idleMs }]))
      .mockResolvedValueOnce(ok()); // toggle_status

    const w = startAutoHandbackWorker({
      tickIntervalMs: 60_000,
      inactivityThresholdMs: 30 * MINUTE,
      now: () => NOW,
    });
    try {
      await w.tick(NOW);
    } finally {
      w.stop();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const toggleCall = fetchMock.mock.calls[1]!;
    expect(String(toggleCall[0])).toMatch(/conversations\/42\/toggle_status$/);
    const toggleBody = JSON.parse((toggleCall[1] as RequestInit).body as string) as unknown;
    expect((toggleBody as Record<string, unknown>)['status']).toBe('pending');
  });

  it('does NOT flip a conversation that is still within the threshold', async () => {
    const idleMs = 20 * MINUTE; // 20 min < 30 min threshold

    fetchMock.mockResolvedValueOnce(
      openConversationsResponse([{ id: 42, lastActivityAtMs: NOW - idleMs }]),
    );

    const w = startAutoHandbackWorker({
      tickIntervalMs: 60_000,
      inactivityThresholdMs: 30 * MINUTE,
      now: () => NOW,
    });
    try {
      await w.tick(NOW);
    } finally {
      w.stop();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the list, no toggle
  });

  it('flips only the idle ones when there are multiple open conversations', async () => {
    fetchMock
      .mockResolvedValueOnce(
        openConversationsResponse([
          { id: 10, lastActivityAtMs: NOW - 40 * MINUTE }, // idle > threshold → flip
          { id: 11, lastActivityAtMs: NOW - 10 * MINUTE }, // recent → keep
          { id: 12, lastActivityAtMs: NOW - 60 * MINUTE }, // very idle → flip
        ]),
      )
      .mockResolvedValueOnce(ok()) // toggle id=10
      .mockResolvedValueOnce(ok()); // toggle id=12

    const w = startAutoHandbackWorker({
      tickIntervalMs: 60_000,
      inactivityThresholdMs: 30 * MINUTE,
      now: () => NOW,
    });
    try {
      await w.tick(NOW);
    } finally {
      w.stop();
    }

    // 1 list call + 2 toggle calls (only ids 10 and 12)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const toggleCalls = fetchMock.mock.calls.slice(1);
    const toggledIds = toggleCalls.map((call) =>
      (String(call[0]!)).match(/conversations\/(\d+)\/toggle_status/)?.[1],
    );
    expect(toggledIds).toContain('10');
    expect(toggledIds).toContain('12');
    expect(toggledIds).not.toContain('11');
  });

  it('does nothing when there are no open conversations', async () => {
    fetchMock.mockResolvedValueOnce(openConversationsResponse([]));

    const w = startAutoHandbackWorker({
      tickIntervalMs: 60_000,
      inactivityThresholdMs: 30 * MINUTE,
      now: () => NOW,
    });
    try {
      await w.tick(NOW);
    } finally {
      w.stop();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1); // just the list
  });

  it('continues flipping remaining conversations when one toggle fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        openConversationsResponse([
          { id: 10, lastActivityAtMs: NOW - 40 * MINUTE },
          { id: 11, lastActivityAtMs: NOW - 45 * MINUTE },
        ]),
      )
      .mockResolvedValueOnce(new Response('server error', { status: 500 })) // toggle id=10 fails
      .mockResolvedValueOnce(ok()); // toggle id=11 succeeds

    const w = startAutoHandbackWorker({
      tickIntervalMs: 60_000,
      inactivityThresholdMs: 30 * MINUTE,
      now: () => NOW,
    });
    try {
      await w.tick(NOW);
    } finally {
      w.stop();
    }

    // All 3 calls were made even though id=10 failed
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const lastToggle = fetchMock.mock.calls[2]!;
    expect(String(lastToggle[0])).toMatch(/conversations\/11\/toggle_status$/);
  });

  it('uses custom inactivity threshold', async () => {
    const CUSTOM_THRESHOLD = 60 * MINUTE;
    const idleMs = 50 * MINUTE; // 50 min < 60 min custom threshold → should NOT flip

    fetchMock.mockResolvedValueOnce(
      openConversationsResponse([{ id: 42, lastActivityAtMs: NOW - idleMs }]),
    );

    const w = startAutoHandbackWorker({
      tickIntervalMs: 60_000,
      inactivityThresholdMs: CUSTOM_THRESHOLD,
      now: () => NOW,
    });
    try {
      await w.tick(NOW);
    } finally {
      w.stop();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1); // list only, no toggle
  });
});
