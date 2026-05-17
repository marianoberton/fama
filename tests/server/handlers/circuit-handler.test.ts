import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/chatwoot.js');
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const {
  sendChatwootMessage,
  addChatwootLabels,
  assignChatwootTeam,
  toggleChatwootStatus,
  ChatwootNotConfiguredError,
} = await import('../../../src/lib/chatwoot.js');
const { llmCircuit, runLlmCircuitFallback } = await import(
  '../../../src/server/handlers/circuit-handler.js'
);

const mockSend = vi.mocked(sendChatwootMessage);
const mockAddLabels = vi.mocked(addChatwootLabels);
const mockAssignTeam = vi.mocked(assignChatwootTeam);
const mockToggleStatus = vi.mocked(toggleChatwootStatus);

const fakeEnv = {
  CHATWOOT_TEAM_ID: 1,
  CHATWOOT_ACCOUNT_ID: 1,
  CHATWOOT_INBOX_ID: 3,
  CHATWOOT_BASE_URL: 'https://chat.fomo.com.ar',
  CHATWOOT_AGENT_BOT_ID: 2,
  CHATWOOT_PATH_TOKEN: 'tok',
  CHATWOOT_API_TOKEN: 'apikey',
  NODE_ENV: 'test',
  OPENAI_API_KEY: 'key',
  MASTRA_DB_URL: 'file:./test.db',
} as ReturnType<typeof import('../../../src/config/env.js').loadEnv>;

describe('llmCircuit', () => {
  beforeEach(() => {
    llmCircuit.reset();
  });

  it('starts in closed state', () => {
    expect(llmCircuit.getState()).toBe('closed');
    expect(llmCircuit.isOpen()).toBe(false);
  });

  it('opens after 3 consecutive failures', () => {
    llmCircuit.recordFailure();
    llmCircuit.recordFailure();
    llmCircuit.recordFailure();
    expect(llmCircuit.getState()).toBe('open');
    expect(llmCircuit.isOpen()).toBe(true);
  });

  it('resets to closed on reset()', () => {
    llmCircuit.recordFailure();
    llmCircuit.recordFailure();
    llmCircuit.recordFailure();
    llmCircuit.reset();
    expect(llmCircuit.getState()).toBe('closed');
  });
});

describe('runLlmCircuitFallback', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockAddLabels.mockReset();
    mockAssignTeam.mockReset();
    mockToggleStatus.mockReset();
    mockSend.mockResolvedValue(undefined);
    mockAddLabels.mockResolvedValue(undefined);
    mockAssignTeam.mockResolvedValue(undefined);
    mockToggleStatus.mockResolvedValue(undefined);
  });

  it('returns 202 with llmCircuitOpen:true', async () => {
    const result = await runLlmCircuitFallback({ conversationId: 1, env: fakeEnv });
    expect(result).toEqual({ status: 202, body: { received: true, llmCircuitOpen: true } });
  });

  it('posts the fixed fallback message to the customer (public)', async () => {
    await runLlmCircuitFallback({ conversationId: 42, env: fakeEnv });
    const publicCall = mockSend.mock.calls.find((c) => !c[0].private);
    expect(publicCall).toBeDefined();
    expect(publicCall![0].conversationId).toBe(42);
    expect(publicCall![0].content).toContain('problema técnico');
  });

  it('posts a private escalation note', async () => {
    await runLlmCircuitFallback({ conversationId: 42, env: fakeEnv });
    const privateCall = mockSend.mock.calls.find((c) => c[0].private);
    expect(privateCall).toBeDefined();
    expect(privateCall![0].content).toContain('LLM circuit abierto');
  });

  it('applies the escalar-humano label and assigns team', async () => {
    await runLlmCircuitFallback({ conversationId: 42, env: fakeEnv });
    expect(mockAddLabels).toHaveBeenCalledWith({
      conversationId: 42,
      labels: ['escalar-humano'],
    });
    expect(mockAssignTeam).toHaveBeenCalledWith({ conversationId: 42, teamId: 1 });
    expect(mockToggleStatus).toHaveBeenCalledWith({ conversationId: 42, status: 'open' });
  });

  it('does not throw when initial send raises ChatwootNotConfiguredError', async () => {
    mockSend.mockRejectedValueOnce(new ChatwootNotConfiguredError());

    const result = await runLlmCircuitFallback({ conversationId: 5, env: fakeEnv });
    expect(result.status).toBe(202);
  });

  it('does not throw when escalation steps fail', async () => {
    mockAddLabels.mockRejectedValue(new Error('Chatwoot down'));

    const result = await runLlmCircuitFallback({ conversationId: 5, env: fakeEnv });
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ received: true, llmCircuitOpen: true });
  });
});
