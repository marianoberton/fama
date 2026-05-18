import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_IDS = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '1';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
  process.env.CHATWOOT_API_TOKEN = 'test-api-token';
});

const { getContactConversations, ChatwootApiError } = await import(
  '../../src/lib/chatwoot.js'
);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getContactConversations', () => {
  it('parses payload-wrapped Chatwoot response with epoch-seconds timestamps', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          payload: [
            {
              id: 4000,
              inbox_id: 3,
              messages_count: 5,
              last_activity_at: 1748952000, // epoch seconds → 2025-06-03T12:00:00Z
              created_at: 1748908800,
            },
            {
              id: 4001,
              inbox_id: 3,
              messages: [{}, {}, {}],
              created_at: 1746000000,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const out = await getContactConversations({ contactId: 91 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe(
      'https://chat.fomo.com.ar/api/v1/accounts/1/contacts/91/conversations',
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).api_access_token).toBe(
      'test-api-token',
    );

    expect(out).toEqual([
      { id: 4000, inboxId: 3, messageCount: 5, lastActivityAtMs: 1748952000_000 },
      { id: 4001, inboxId: 3, messageCount: 3, lastActivityAtMs: 1746000000_000 },
    ]);
  });

  it('handles top-level array response shape', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 1, inbox_id: 3, messages_count: 2, last_activity_at: 1748000000 },
        ]),
        { status: 200 },
      ),
    );
    const out = await getContactConversations({ contactId: 91 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(1);
  });

  it('throws ChatwootApiError on 5xx', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(getContactConversations({ contactId: 91 })).rejects.toBeInstanceOf(
      ChatwootApiError,
    );
  });

  it('aborts the request when timeout elapses (fail-closed signal upstream)', async () => {
    // Simulate fetch that listens to the AbortSignal and rejects with AbortError.
    fetchMock.mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    await expect(
      getContactConversations({ contactId: 91, timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
