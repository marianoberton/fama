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
  };
});

const { handleChatwootWebhook } = await import('../../src/server/webhook.js');
const { sendChatwootMessage, ChatwootNotConfiguredError } = await import(
  '../../src/lib/chatwoot.js'
);
const {
  setNurturingStoreClientForTests,
  _truncateForTests,
  recordOutbound,
  recordInbound,
} = await import('../../src/lib/nurturing-store.js');
const { WELCOME_TEXT } = await import('../../src/lib/welcome.js');
const mockSend = vi.mocked(sendChatwootMessage);

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
    const client = createClient({ url: ':memory:' });
    await setNurturingStoreClientForTests(client);
    await _truncateForTests();
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
});
