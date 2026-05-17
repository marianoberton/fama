import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/chatwoot.js');
vi.mock('../../../src/lib/known-customer.js');
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { getContactConversations } = await import('../../../src/lib/chatwoot.js');
const { detectKnownCustomer, formatKnownCustomerContext } = await import(
  '../../../src/lib/known-customer.js'
);
const { resolveKnownCustomer } = await import(
  '../../../src/server/handlers/known-customer-handler.js'
);

const mockGetConversations = vi.mocked(getContactConversations);
const mockDetect = vi.mocked(detectKnownCustomer);
const mockFormat = vi.mocked(formatKnownCustomerContext);

describe('resolveKnownCustomer', () => {
  beforeEach(() => {
    mockGetConversations.mockReset();
    mockDetect.mockReset();
    mockFormat.mockReset();
  });

  it('returns knownContext=null when no prior conversations qualify', async () => {
    mockGetConversations.mockResolvedValue([]);
    mockDetect.mockReturnValue({ known: false, count: 0, lastConversationAt: 0 });

    const result = await resolveKnownCustomer({
      contactId: 91,
      conversationId: 4248,
      inboxId: 3,
    });

    expect(result).toEqual({ knownContext: null });
    expect(mockGetConversations).toHaveBeenCalledWith({ contactId: 91 });
    expect(mockDetect).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: 3, excludeConversationId: 4248 }),
    );
  });

  it('returns knownContext string when prior conversations qualify', async () => {
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    mockGetConversations.mockResolvedValue([
      { id: 100, inboxId: 3, messageCount: 5, lastActivityAtMs: fiveDaysAgo },
    ]);
    mockDetect.mockReturnValue({ known: true, count: 1, lastConversationAt: fiveDaysAgo });
    mockFormat.mockReturnValue('[CONTEXTO_SISTEMA] Este es un cliente conocido con 1 conversación.');

    const result = await resolveKnownCustomer({
      contactId: 91,
      conversationId: 4248,
      inboxId: 3,
    });

    expect(result.knownContext).toContain('[CONTEXTO_SISTEMA]');
    expect(mockFormat).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.objectContaining({ known: true }) }),
    );
  });

  it('returns knownContext=null (fail-closed) when getContactConversations throws', async () => {
    mockGetConversations.mockRejectedValue(new Error('Chatwoot 500'));

    const result = await resolveKnownCustomer({
      contactId: 91,
      conversationId: 4248,
      inboxId: 3,
    });

    expect(result).toEqual({ knownContext: null });
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('returns knownContext=null (fail-closed) when detectKnownCustomer throws', async () => {
    mockGetConversations.mockResolvedValue([]);
    mockDetect.mockImplementation(() => {
      throw new Error('unexpected');
    });

    const result = await resolveKnownCustomer({
      contactId: 91,
      conversationId: 4248,
      inboxId: 3,
    });

    expect(result).toEqual({ knownContext: null });
  });

  it('passes excludeConversationId to detectKnownCustomer so current convo is not counted', async () => {
    mockGetConversations.mockResolvedValue([]);
    mockDetect.mockReturnValue({ known: false, count: 0, lastConversationAt: 0 });

    await resolveKnownCustomer({ contactId: 7, conversationId: 9999, inboxId: 3 });

    expect(mockDetect).toHaveBeenCalledWith(
      expect.objectContaining({ excludeConversationId: 9999 }),
    );
  });
});
