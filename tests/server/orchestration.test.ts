import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'webhook');

function happyPathBody(): string {
  const raw = readFileSync(path.join(fixturesDir, '07-happy-path.json'), 'utf8');
  const { _meta: _ignored, ...rest } = JSON.parse(raw) as Record<string, unknown> & {
    _meta?: unknown;
  };
  return JSON.stringify(rest);
}

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
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('on filter pass, invokes recepcionista with thread + resource derived from conversation/contact ids and posts the reply', async () => {
    const { mastra, getAgent, generate } = buildMockMastra(async () => ({
      text: 'Hola, ¿en qué puedo ayudarte?',
      steps: [],
    }));
    mockSend.mockResolvedValue(undefined);

    const outcome = await handleChatwootWebhook({
      pathToken: 'test-path-token',
      rawBody: happyPathBody(),
      mastra,
    });

    expect(outcome).toEqual({ status: 202, body: { received: true } });
    expect(getAgent).toHaveBeenCalledWith('recepcionista');
    expect(generate).toHaveBeenCalledWith(
      'Hola! Me interesa el plan Equipo, ¿cómo es?',
      expect.objectContaining({
        memory: { thread: 'chatwoot-4248', resource: 'contact-91' },
        maxSteps: 8,
      }),
    );
    expect(mockSend).toHaveBeenCalledWith({
      conversationId: 4248,
      content: 'Hola, ¿en qué puedo ayudarte?',
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
      rawBody: happyPathBody(),
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
      rawBody: happyPathBody(),
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
