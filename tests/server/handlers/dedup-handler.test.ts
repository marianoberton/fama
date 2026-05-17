import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/dedup-store.js');
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { tryMarkProcessed } = await import('../../../src/lib/dedup-store.js');
const { runDedupCheck } = await import('../../../src/server/handlers/dedup-handler.js');
const mockTryMarkProcessed = vi.mocked(tryMarkProcessed);

describe('runDedupCheck', () => {
  beforeEach(() => {
    mockTryMarkProcessed.mockReset();
  });

  it('returns isDuplicate=false when message has not been seen before', async () => {
    mockTryMarkProcessed.mockResolvedValue(true);
    const result = await runDedupCheck({ messageId: 1, conversationId: 100 });
    expect(result).toEqual({ isDuplicate: false });
    expect(mockTryMarkProcessed).toHaveBeenCalledWith(1);
  });

  it('returns isDuplicate=true when message was already processed', async () => {
    mockTryMarkProcessed.mockResolvedValue(false);
    const result = await runDedupCheck({ messageId: 42, conversationId: 200 });
    expect(result).toEqual({ isDuplicate: true });
  });

  it('returns isDuplicate=false (fail-open) when tryMarkProcessed throws', async () => {
    mockTryMarkProcessed.mockRejectedValue(new Error('DB locked'));
    const result = await runDedupCheck({ messageId: 7, conversationId: 300 });
    expect(result).toEqual({ isDuplicate: false });
  });
});
