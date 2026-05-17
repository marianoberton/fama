import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/welcome.js');
vi.mock('../../../src/lib/chatwoot.js');
vi.mock('../../../src/lib/nurturing-store.js');
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { shouldSendHardcodedWelcome, WELCOME_TEXT } = await import('../../../src/lib/welcome.js');
const { sendChatwootMessage, ChatwootNotConfiguredError } = await import(
  '../../../src/lib/chatwoot.js'
);
const { recordOutbound } = await import('../../../src/lib/nurturing-store.js');
const { handleWelcomePath } = await import('../../../src/server/handlers/welcome-handler.js');

const mockShouldSend = vi.mocked(shouldSendHardcodedWelcome);
const mockSend = vi.mocked(sendChatwootMessage);
const mockRecordOutbound = vi.mocked(recordOutbound);

// Make WELCOME_TEXT readable in tests
vi.mocked(WELCOME_TEXT as unknown as () => string);

describe('handleWelcomePath', () => {
  const baseInput = {
    conversationId: 4248,
    effectiveContent: 'Hola',
    isFirstTurn: true,
    knownContext: null,
    hasMedia: false,
  };

  beforeEach(() => {
    mockShouldSend.mockReset();
    mockSend.mockReset();
    mockRecordOutbound.mockReset();
    mockSend.mockResolvedValue(undefined);
    mockRecordOutbound.mockResolvedValue(undefined);
  });

  it('returns handled=false when knownContext is not null', async () => {
    mockShouldSend.mockReturnValue(true);
    const result = await handleWelcomePath({ ...baseInput, knownContext: 'some context' });
    expect(result).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns handled=false when hasMedia is true', async () => {
    mockShouldSend.mockReturnValue(true);
    const result = await handleWelcomePath({ ...baseInput, hasMedia: true });
    expect(result).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns handled=false when shouldSendHardcodedWelcome returns false', async () => {
    mockShouldSend.mockReturnValue(false);
    const result = await handleWelcomePath(baseInput);
    expect(result).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('posts welcome and returns handled=true with welcome outcome on happy path', async () => {
    mockShouldSend.mockReturnValue(true);

    const result = await handleWelcomePath(baseInput);

    expect(result.handled).toBe(true);
    expect(result.outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    expect(mockSend).toHaveBeenCalledWith({ conversationId: 4248, content: expect.any(String) });
    expect(mockRecordOutbound).toHaveBeenCalledWith({ conversationId: 4248 });
  });

  it('returns handled=true with welcome outcome when Chatwoot is not configured (logs warn, no error)', async () => {
    mockShouldSend.mockReturnValue(true);
    mockSend.mockRejectedValue(new ChatwootNotConfiguredError());

    const result = await handleWelcomePath(baseInput);

    expect(result.handled).toBe(true);
    expect(result.outcome).toEqual({ status: 202, body: { received: true, welcome: true } });
    // recordOutbound should NOT be called since send failed before it
    expect(mockRecordOutbound).not.toHaveBeenCalled();
  });

  it('returns handled=true with 500 outcome when sendChatwootMessage throws an unexpected error', async () => {
    mockShouldSend.mockReturnValue(true);
    mockSend.mockRejectedValue(new Error('network down'));

    const result = await handleWelcomePath(baseInput);

    expect(result.handled).toBe(true);
    expect(result.outcome).toEqual({ status: 500, body: { error: 'agent_or_post_failed' } });
  });

  it('does not throw when recordOutbound fails (fail-soft)', async () => {
    mockShouldSend.mockReturnValue(true);
    mockRecordOutbound.mockRejectedValue(new Error('DB error'));

    const result = await handleWelcomePath(baseInput);

    expect(result.handled).toBe(true);
    expect(result.outcome?.status).toBe(202);
  });
});
