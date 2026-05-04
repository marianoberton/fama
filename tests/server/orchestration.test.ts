import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'webhook');

function happyPathBody(messageContent?: string): string {
  const raw = readFileSync(path.join(fixturesDir, '07-happy-path.json'), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown> & { _meta?: unknown };
  const { _meta: _ignored, ...rest } = parsed;
  if (messageContent !== undefined) {
    rest.content = messageContent;
    const messages = (rest.messages as Array<Record<string, unknown>>).map((m) => ({
      ...m,
      content: messageContent,
    }));
    rest.messages = messages;
  }
  return JSON.stringify(rest);
}

const LONG_MESSAGE =
  'Hola buenas tardes mi nombre es Juan Perez y soy el director comercial ' +
  'de una empresa de cinco mil empleados que necesitamos urgente implementar ' +
  'agentes de IA para atencion al cliente porque tenemos un volumen muy alto ' +
  'de mensajes que no estamos pudiendo procesar con el equipo actual y queremos ' +
  'arrancar el proximo mes con un piloto de tres meses para evaluar resultados.';

// Env must be set before any module under test calls loadEnv(). loadEnv()
// caches on first call, so this fixture-level setup is sufficient.
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

vi.mock('../../src/lib/chatwoot.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/chatwoot.js')>();
  return {
    ...actual,
    sendChatwootMessage: vi.fn(),
    getContactConversations: vi.fn(),
  };
});

const { handleChatwootWebhook } = await import('../../src/server/webhook.js');
const {
  sendChatwootMessage,
  getContactConversations,
  ChatwootNotConfiguredError,
} = await import('../../src/lib/chatwoot.js');
const {
  setNurturingStoreClientForTests,
  _truncateForTests,
  recordOutbound,
  recordInbound,
} = await import('../../src/lib/nurturing-store.js');
const {
  setDedupStoreClientForTests,
  _truncateForTests: _truncateDedupForTests,
} = await import('../../src/lib/dedup-store.js');
const { WELCOME_TEXT } = await import('../../src/lib/welcome.js');
const mockSend = vi.mocked(sendChatwootMessage);
const mockGetContactConversations = vi.mocked(getContactConversations);

function buildMockMastra(generateImpl: () => unknown) {
  const generate = vi.fn().mockImplementation(generateImpl);
  const getAgent = vi.fn().mockReturnValue({ generate });
  const mastra = { getAgent } as unknown as Parameters<
    typeof handleChatwootWebhook
  >[0]['mastra'];
  return { mastra, getAgent, generate };
}

describe('orchestration: webhook → recepcionista', () => {
  beforeEach(async () => {
    mockSend.mockReset();
    mockGetContactConversations.mockReset();
    // Default: no prior conversations for the contact (unknown customer).
    mockGetContactConversations.mockResolvedValue([]);
    const client = createClient({ url: ':memory:' });
    await setNurturingStoreClientForTests(client);
    await _truncateForTests();
    const dedupClient = createClient({ url: ':memory:' });
    await setDedupStoreClientForTests(dedupClient);
    await _truncateDedupForTests();
  });

  it('on filter pass with a long enough first message, invokes recepcionista and posts the reply', async () => {
    const { mastra, getAgent, generate } = buildMockMastra(async () => ({
      text: 'Hola Juan, gracias por escribirnos. Te paso info enseguida.',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody(LONG_MESSAGE),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true } });
    expect(getAgent).toHaveBeenCalledWith('recepcionista');
    expect(generate).toHaveBeenCalledWith(
      LONG_MESSAGE,
      expect.objectContaining({
        memory: { thread: 'chatwoot-4248', resource: 'contact-91' },
        maxSteps: 8,
      }),
    );
    expect(mockSend).toHaveBeenCalledWith({
      conversationId: 4248,
      content: 'Hola Juan, gracias por escribirnos. Te paso info enseguida.',
    });
  });

  it('short first turn (<30 words, no prior outbound) → posts hard-coded welcome and skips the LLM', async () => {
    const { mastra, generate } = buildMockMastra(async () => ({ text: 'no llamar', steps: [] }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola, info'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    expect(generate).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ conversationId: 4248, content: WELCOME_TEXT });
  });

  it('short message but NOT first turn (we already replied before) → goes to LLM', async () => {
    // Pre-seed: we already replied at some point.
    await recordInbound({ conversationId: 4248, contactId: 91, now: Date.now() - 10_000 });
    await recordOutbound({ conversationId: 4248, now: Date.now() - 5_000 });

    const { mastra, generate } = buildMockMastra(async () => ({
      text: 'Claro, te paso más info.',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Dale, contame más'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      conversationId: 4248,
      content: 'Claro, te paso más info.',
    });
  });

  it('long first turn (≥30 words) → still goes to LLM (welcome path skipped)', async () => {
    const { mastra, generate } = buildMockMastra(async () => ({
      text: 'Listo, te ayudo.',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody(LONG_MESSAGE),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      conversationId: 4248,
      content: 'Listo, te ayudo.',
    });
  });

  it('still returns 202 when CHATWOOT_API_TOKEN is missing — logs warning and skips outbound post', async () => {
    const { mastra } = buildMockMastra(async () => ({
      text: 'cualquier reply',
      steps: [],
    }));
    mockSend.mockRejectedValue(new ChatwootNotConfiguredError());

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody(LONG_MESSAGE),
      mastra,
    });

    expect(outcome.status).toBe(202);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the agent throws', async () => {
    const { mastra, generate } = buildMockMastra(async () => {
      throw new Error('OpenAI offline');
    });

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody(LONG_MESSAGE),
      mastra,
    });

    expect(outcome.status).toBe(500);
    expect(outcome.body).toEqual({ error: 'agent_or_post_failed' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 500 when filter passes but message extraction fails (no top-level conversation.id)', async () => {
    const { mastra, generate } = buildMockMastra(async () => ({
      text: 'x',
      steps: [],
    }));

    const malformed = {
      event: 'message_created',
      account: { id: 1 },
      messages: [
        {
          message_type: 0,
          content: 'hola',
          sender: { id: 91, type: 'contact' },
        },
      ],
    };

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: JSON.stringify(malformed),
      mastra,
    });

    expect(outcome.status).toBe(500);
    expect(outcome.body).toEqual({ error: 'message_extraction_failed' });
    expect(generate).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('chatwoot v4.12.1 nested shape: extractMessage reads conversation.messages[0] and invokes agent', async () => {
    // Same shape as fixture 08 but with a long message so welcome path is skipped
    // and the LLM gets invoked. Verifies the entire webhook → extract → generate
    // path works on the real Chatwoot v4.12.1 payload (no root `messages` array).
    const v412Body = {
      account: { id: 1 },
      content: LONG_MESSAGE,
      conversation: {
        id: 8,
        inbox_id: 3,
        status: 'pending',
        messages: [
          {
            id: 76,
            content: LONG_MESSAGE,
            message_type: 0,
            sender: { id: 2, type: 'contact', name: 'Mariano' },
          },
        ],
      },
      id: 76,
      message_type: 'incoming',
      sender: { id: 2, name: 'Mariano' },
      event: 'message_created',
    };
    const { mastra, generate } = buildMockMastra(async () => ({
      text: 'Listo, te ayudo.',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: JSON.stringify(v412Body),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true } });
    expect(generate).toHaveBeenCalledWith(
      LONG_MESSAGE,
      expect.objectContaining({
        memory: { thread: 'chatwoot-8', resource: 'contact-2' },
      }),
    );
    expect(mockSend).toHaveBeenCalledWith({
      conversationId: 8,
      content: 'Listo, te ayudo.',
    });
  });

  it('duplicate Chatwoot retry (same message id) → 200 silent, agent NOT invoked, no outbound', async () => {
    // First delivery: full happy path. Second delivery: identical body — must
    // be deduped before any side effect.
    const { mastra, generate } = buildMockMastra(async () => ({
      text: 'Hola Juan, gracias por escribirnos. Te paso info.',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const first = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody(LONG_MESSAGE),
      mastra,
    });
    expect(first.status).toBe(202);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const second = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody(LONG_MESSAGE),
      mastra,
    });
    expect(second).toEqual({ status: 200, body: { ignored: 'duplicate_message' } });
    // Agent and outbound counts must not have grown.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('orchestration: known-customer detection', () => {
  beforeEach(async () => {
    mockSend.mockReset();
    mockGetContactConversations.mockReset();
    mockGetContactConversations.mockResolvedValue([]);
    const client = createClient({ url: ':memory:' });
    await setNurturingStoreClientForTests(client);
    await _truncateForTests();
    const dedupClient = createClient({ url: ':memory:' });
    await setDedupStoreClientForTests(dedupClient);
    await _truncateDedupForTests();
  });

  // Test 1 — no prior conversations → normal flow with neutral welcome.
  it('contact with no prior conversations → unknown, sends new welcome text', async () => {
    mockGetContactConversations.mockResolvedValue([]);
    const { mastra, generate } = buildMockMastra(async () => ({ text: 'no llamar', steps: [] }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola, info'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    expect(generate).not.toHaveBeenCalled();
    expect(mockGetContactConversations).toHaveBeenCalledWith({ contactId: 91 });
    expect(mockSend).toHaveBeenCalledWith({ conversationId: 4248, content: WELCOME_TEXT });
    expect(WELCOME_TEXT).toBe('Hola, gracias por escribirnos a FOMO. ¿En qué puedo ayudarte?');
  });

  // Test 2 — 1 prior conversation, 5 days old, 5 messages → known, no welcome, LLM with context.
  it('contact with 1 valid prior (5 days, 5 msgs) → known, skips welcome, injects context to LLM', async () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    mockGetContactConversations.mockResolvedValue([
      { id: 4000, inboxId: 3, messageCount: 5, lastActivityAtMs: fiveDaysAgo },
    ]);
    const { mastra, generate } = buildMockMastra(async () => ({
      text: 'Hola de nuevo. ¿En qué te puedo ayudar?',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola, info'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    const generatedInput = generate.mock.calls[0]![0] as string;
    expect(generatedInput).toContain('[CONTEXTO_SISTEMA]');
    expect(generatedInput).toContain('Este es un cliente conocido');
    expect(generatedInput).toContain('1 conversación previa');
    expect(generatedInput).toContain('Hola, info');
    expect(mockSend).toHaveBeenCalledWith({
      conversationId: 4248,
      content: 'Hola de nuevo. ¿En qué te puedo ayudar?',
    });
  });

  // Test 3 — 1 prior conversation, 5 days old, but only 1 message (abandoned) → not known.
  it('contact with 1 abandoned prior (1 msg only) → not known, normal welcome flow', async () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    mockGetContactConversations.mockResolvedValue([
      { id: 4000, inboxId: 3, messageCount: 1, lastActivityAtMs: fiveDaysAgo },
    ]);
    const { mastra, generate } = buildMockMastra(async () => ({ text: 'x', steps: [] }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola, info'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    expect(generate).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({ conversationId: 4248, content: WELCOME_TEXT });
  });

  // Test 4 — prior conversation 60 days old → out of window → not known.
  it('contact with prior conversation 60 days old → out of window, not known', async () => {
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    mockGetContactConversations.mockResolvedValue([
      { id: 4000, inboxId: 3, messageCount: 10, lastActivityAtMs: sixtyDaysAgo },
    ]);
    const { mastra, generate } = buildMockMastra(async () => ({ text: 'x', steps: [] }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola, info'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    expect(generate).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({ conversationId: 4248, content: WELCOME_TEXT });
  });

  // Test 5 — Chatwoot API returns 500 → fail closed → normal welcome flow.
  it('Chatwoot API 500 on lookup → fail-closed, treats as unknown, sends welcome', async () => {
    mockGetContactConversations.mockRejectedValue(
      new Error('Chatwoot API error: 500 Server Error — boom'),
    );
    const { mastra, generate } = buildMockMastra(async () => ({ text: 'x', steps: [] }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola, info'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    expect(generate).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({ conversationId: 4248, content: WELCOME_TEXT });
  });

  // Test 6 — timeout (AbortError) → fail closed → normal welcome flow.
  it('Chatwoot API timeout (AbortError) → fail-closed, treats as unknown', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    mockGetContactConversations.mockRejectedValue(abortErr);
    const { mastra, generate } = buildMockMastra(async () => ({ text: 'x', steps: [] }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola, info'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    expect(generate).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({ conversationId: 4248, content: WELCOME_TEXT });
  });

  // Test 7 — 3 valid prior conversations → known, context includes correct count.
  it('contact with 3 valid prior conversations within 30 days → known, count=3 in context', async () => {
    const now = Date.now();
    mockGetContactConversations.mockResolvedValue([
      { id: 4000, inboxId: 3, messageCount: 4, lastActivityAtMs: now - 3 * 24 * 60 * 60 * 1000 },
      { id: 4001, inboxId: 3, messageCount: 6, lastActivityAtMs: now - 12 * 24 * 60 * 60 * 1000 },
      { id: 4002, inboxId: 3, messageCount: 2, lastActivityAtMs: now - 25 * 24 * 60 * 60 * 1000 },
      // Out-of-window — should NOT count.
      { id: 4003, inboxId: 3, messageCount: 8, lastActivityAtMs: now - 50 * 24 * 60 * 60 * 1000 },
      // Wrong inbox — should NOT count.
      { id: 4004, inboxId: 99, messageCount: 5, lastActivityAtMs: now - 2 * 24 * 60 * 60 * 1000 },
      // The current conversation — should NOT count.
      { id: 4248, inboxId: 3, messageCount: 1, lastActivityAtMs: now },
    ]);
    const { mastra, generate } = buildMockMastra(async () => ({
      text: 'Hola de nuevo, contame.',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody('Hola'),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    const generatedInput = generate.mock.calls[0]![0] as string;
    expect(generatedInput).toContain('3 conversaciones previas');
    // Most recent valid was 3 days ago.
    expect(generatedInput).toMatch(/hace 3 días/);
  });
});
