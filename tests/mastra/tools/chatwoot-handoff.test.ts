import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

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

const { runHandoff, _resetHandoffLockForTests } = await import(
  '../../../src/mastra/tools/chatwoot-handoff.js'
);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  _resetHandoffLockForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(): Response {
  return new Response(JSON.stringify({}), { status: 200 });
}

function fail(status: number, text: string): Response {
  return new Response(text, { status, statusText: 'Error' });
}

const baseInput = {
  conversationId: 4248,
  category: 'venta-agentes' as const,
  ackMessage: 'Te paso con un asesor del equipo, te respondemos a la brevedad.',
  reason:
    'Categoría: venta-agentes\nMotivo: Lead concreto, pide cotización para 3 agentes de IA.\nCliente: María González\nEmpresa: Acme S.A.\nDatos clave: presupuesto USD 5k, plazo 1 mes',
};

describe('chatwoot-handoff: runHandoff', () => {
  it('happy path: fires 5 calls in order (ack → labels → private note → assign → toggle_status)', async () => {
    fetchMock.mockResolvedValue(ok());

    const result = await runHandoff(baseInput);

    expect(result).toEqual({
      success: true,
      step_failed: null,
      replyHandled: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const calls = fetchMock.mock.calls;
    const urls = calls.map(([url]) => String(url));
    expect(urls[0]).toBe(
      'https://chat.fomo.com.ar/api/v1/accounts/1/conversations/4248/messages',
    );
    expect(urls[1]).toBe(
      'https://chat.fomo.com.ar/api/v1/accounts/1/conversations/4248/labels',
    );
    expect(urls[2]).toBe(
      'https://chat.fomo.com.ar/api/v1/accounts/1/conversations/4248/messages',
    );
    expect(urls[3]).toBe(
      'https://chat.fomo.com.ar/api/v1/accounts/1/conversations/4248/assignments',
    );
    expect(urls[4]).toBe(
      'https://chat.fomo.com.ar/api/v1/accounts/1/conversations/4248/toggle_status',
    );

    // Step 0 body — public ack
    const step0Body = JSON.parse(String(calls[0]![1]!.body));
    expect(step0Body).toEqual({
      content: baseInput.ackMessage,
      message_type: 'outgoing',
      private: false,
    });
    // Step 1 body — labels
    expect(JSON.parse(String(calls[1]![1]!.body))).toEqual({
      labels: ['venta-agentes'],
    });
    // Step 2 body — private note
    const step2Body = JSON.parse(String(calls[2]![1]!.body));
    expect(step2Body.private).toBe(true);
    expect(step2Body.message_type).toBe('outgoing');
    expect(step2Body.content).toBe(baseInput.reason);
    // Step 3 body — team assignment with env's CHATWOOT_TEAM_ID
    expect(JSON.parse(String(calls[3]![1]!.body))).toEqual({ team_id: 7 });
    // Step 4 body — status open
    expect(JSON.parse(String(calls[4]![1]!.body))).toEqual({ status: 'open' });

    // All requests carry the api_access_token header
    for (const [, init] of calls) {
      const headers = init!.headers as Record<string, string>;
      expect(headers.api_access_token).toBe('test-api-token');
      expect(headers['Content-Type']).toBe('application/json');
    }
  });

  it('reports step_failed=0 + replyHandled=false when the public ack post fails', async () => {
    fetchMock.mockResolvedValueOnce(fail(500, 'boom'));

    const result = await runHandoff(baseInput);

    expect(result.success).toBe(false);
    expect(result.step_failed).toBe(0);
    expect(result.replyHandled).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports step_failed=1 + replyHandled=true when labels fail (ack already posted)', async () => {
    fetchMock
      .mockResolvedValueOnce(ok()) // step 0 — ack
      .mockResolvedValueOnce(fail(422, 'invalid label')); // step 1 — labels

    const result = await runHandoff(baseInput);

    expect(result.success).toBe(false);
    expect(result.step_failed).toBe(1);
    expect(result.replyHandled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports step_failed=4 when toggle_status fails on the last step', async () => {
    fetchMock
      .mockResolvedValueOnce(ok()) // 0
      .mockResolvedValueOnce(ok()) // 1
      .mockResolvedValueOnce(ok()) // 2
      .mockResolvedValueOnce(ok()) // 3
      .mockResolvedValueOnce(fail(503, 'service unavailable')); // 4

    const result = await runHandoff(baseInput);

    expect(result.success).toBe(false);
    expect(result.step_failed).toBe(4);
    expect(result.replyHandled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('returns idempotent skip when the lock is held (second call within 60s window)', async () => {
    fetchMock.mockResolvedValue(ok());

    const first = await runHandoff(baseInput);
    expect(first.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const second = await runHandoff(baseInput);
    expect(second).toEqual({
      success: true,
      step_failed: null,
      replyHandled: true,
      idempotentSkip: true,
    });
    // No new fetches on the idempotent skip.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('releases the lock on failure so a retry can actually fire', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(500, 'boom')) // first attempt fails on step 0
      .mockResolvedValue(ok()); // retry succeeds across all 5

    const first = await runHandoff(baseInput);
    expect(first.success).toBe(false);
    expect(first.step_failed).toBe(0);

    const second = await runHandoff(baseInput);
    expect(second).toEqual({
      success: true,
      step_failed: null,
      replyHandled: true,
    });
    // 1 (failed first attempt) + 5 (retry) = 6 total.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
