import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/attachment-processor.js');
vi.mock('../../../src/lib/twenty.js');
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { processAttachments } = await import('../../../src/lib/attachment-processor.js');
const {
  isTwentyConfigured,
  findOrCreatePersonByPhone,
  createAttachment,
} = await import('../../../src/lib/twenty.js');
const { processMessageAttachments, syncAttachmentsToTwenty } = await import(
  '../../../src/server/handlers/attachment-handler.js'
);

const mockProcessAttachments = vi.mocked(processAttachments);
const mockIsTwentyConfigured = vi.mocked(isTwentyConfigured);
const mockFindOrCreate = vi.mocked(findOrCreatePersonByPhone);
const mockCreateAttachment = vi.mocked(createAttachment);

// ---------------------------------------------------------------------------
// processMessageAttachments
// ---------------------------------------------------------------------------
describe('processMessageAttachments', () => {
  beforeEach(() => {
    mockProcessAttachments.mockReset();
  });

  it('returns original content and empty arrays when there are no attachments', async () => {
    const result = await processMessageAttachments({
      originalContent: 'hello',
      attachments: [],
      conversationId: 1,
    });
    expect(result).toEqual({
      effectiveContent: 'hello',
      processedAttachments: [],
      hasMedia: false,
    });
    expect(mockProcessAttachments).not.toHaveBeenCalled();
  });

  it('returns enriched content when attachments are processed successfully', async () => {
    mockProcessAttachments.mockResolvedValue({
      enrichedContent: 'hello [audio del cliente]: transcripción',
      processed: [
        { id: 1, category: 'AUDIO', dataUrl: 'https://chat/1.opus', filename: 'audio-1.opus', extractedText: 'transcripción' },
      ],
      hasMedia: true,
    });

    const result = await processMessageAttachments({
      originalContent: 'hello',
      attachments: [{ id: 1, fileType: 'audio', dataUrl: 'https://chat/1.opus' } as any],
      conversationId: 10,
    });

    expect(result.effectiveContent).toContain('transcripción');
    expect(result.hasMedia).toBe(true);
    expect(result.processedAttachments).toHaveLength(1);
  });

  it('falls through with original content when processAttachments crashes', async () => {
    mockProcessAttachments.mockRejectedValue(new Error('Whisper down'));

    const result = await processMessageAttachments({
      originalContent: 'original',
      attachments: [{ id: 1, fileType: 'audio', dataUrl: 'https://x.com/1.opus' } as any],
      conversationId: 5,
    });

    expect(result).toEqual({
      effectiveContent: 'original',
      processedAttachments: [],
      hasMedia: false,
    });
  });
});

// ---------------------------------------------------------------------------
// syncAttachmentsToTwenty
// ---------------------------------------------------------------------------
describe('syncAttachmentsToTwenty', () => {
  const baseInput = {
    phone: '+541122334455',
    contactName: 'Juan',
    conversationId: 100,
    baseUrl: 'https://chat.fomo.com.ar',
    accountId: 1,
  };

  beforeEach(() => {
    mockIsTwentyConfigured.mockReset();
    mockFindOrCreate.mockReset();
    mockCreateAttachment.mockReset();
  });

  it('returns early when processed list is empty', async () => {
    await syncAttachmentsToTwenty({ ...baseInput, processed: [] });
    expect(mockIsTwentyConfigured).not.toHaveBeenCalled();
  });

  it('returns early when phone is empty', async () => {
    await syncAttachmentsToTwenty({
      ...baseInput,
      phone: '',
      processed: [{ id: 1, category: 'AUDIO', dataUrl: 'x', filename: 'audio-1.opus', extractedText: null }],
    });
    expect(mockIsTwentyConfigured).not.toHaveBeenCalled();
  });

  it('returns early when Twenty is not configured', async () => {
    mockIsTwentyConfigured.mockReturnValue(false);
    await syncAttachmentsToTwenty({
      ...baseInput,
      processed: [{ id: 1, category: 'AUDIO', dataUrl: 'x', filename: 'audio-1.opus', extractedText: null }],
    });
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it('creates AUDIO attachment in Twenty for each AUDIO processed attachment', async () => {
    mockIsTwentyConfigured.mockReturnValue(true);
    mockFindOrCreate.mockResolvedValue({ person: { id: 'person-1' }, created: false });
    mockCreateAttachment.mockResolvedValue({ id: 'att-1' });

    await syncAttachmentsToTwenty({
      ...baseInput,
      processed: [{ id: 1, category: 'AUDIO', dataUrl: 'https://chat/1.opus', filename: 'audio-1.opus', extractedText: 'hola' }],
    });

    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+541122334455' }),
    );
    expect(mockCreateAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        fileCategory: 'AUDIO',
        fullPath: 'https://chat/1.opus',
        personId: 'person-1',
      }),
    );
  });

  it('creates IMAGE attachment in Twenty for each IMAGE processed attachment', async () => {
    mockIsTwentyConfigured.mockReturnValue(true);
    mockFindOrCreate.mockResolvedValue({ person: { id: 'person-2' }, created: false });
    mockCreateAttachment.mockResolvedValue({ id: 'att-2' });

    await syncAttachmentsToTwenty({
      ...baseInput,
      processed: [{ id: 2, category: 'IMAGE', dataUrl: 'https://chat/2.jpg', filename: 'image-2.jpg', extractedText: 'desc' }],
    });

    expect(mockCreateAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ fileCategory: 'IMAGE' }),
    );
  });

  it('skips OTHER category attachments', async () => {
    mockIsTwentyConfigured.mockReturnValue(true);
    mockFindOrCreate.mockResolvedValue({ person: { id: 'person-3' }, created: false });

    await syncAttachmentsToTwenty({
      ...baseInput,
      processed: [{ id: 3, category: 'OTHER', dataUrl: 'x', filename: 'file.pdf', extractedText: null }],
    });

    expect(mockCreateAttachment).not.toHaveBeenCalled();
  });

  it('continues after a single createAttachment failure', async () => {
    mockIsTwentyConfigured.mockReturnValue(true);
    mockFindOrCreate.mockResolvedValue({ person: { id: 'person-4' }, created: false });
    mockCreateAttachment
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ id: 'att-ok' });

    await syncAttachmentsToTwenty({
      ...baseInput,
      processed: [
        { id: 4, category: 'AUDIO', dataUrl: 'x', filename: 'audio-4.opus', extractedText: null },
        { id: 5, category: 'IMAGE', dataUrl: 'y', filename: 'image-5.jpg', extractedText: null },
      ],
    });

    expect(mockCreateAttachment).toHaveBeenCalledTimes(2);
  });

  it('aborts all attachments when findOrCreatePersonByPhone throws', async () => {
    mockIsTwentyConfigured.mockReturnValue(true);
    mockFindOrCreate.mockRejectedValue(new Error('Twenty 500'));

    await syncAttachmentsToTwenty({
      ...baseInput,
      processed: [{ id: 6, category: 'AUDIO', dataUrl: 'x', filename: 'audio-6.opus', extractedText: null }],
    });

    expect(mockCreateAttachment).not.toHaveBeenCalled();
  });

  it('uses "Anónimo" as fallback name when contactName is empty', async () => {
    mockIsTwentyConfigured.mockReturnValue(true);
    mockFindOrCreate.mockResolvedValue({ person: { id: 'p' }, created: true });
    mockCreateAttachment.mockResolvedValue({ id: 'a' });

    await syncAttachmentsToTwenty({
      ...baseInput,
      contactName: '   ',
      processed: [{ id: 7, category: 'AUDIO', dataUrl: 'x', filename: 'audio-7.opus', extractedText: null }],
    });

    expect(mockFindOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackFirstName: 'Anónimo' }),
    );
  });
});
