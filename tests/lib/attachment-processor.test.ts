import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_ID = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '1';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
});

// Mock the OpenAI multimodal wrappers — we don't want to call OpenAI in CI.
vi.mock('../../src/lib/openai-multimodal.js', () => ({
  transcribeAudio: vi.fn(),
  describeImage: vi.fn(),
  _resetOpenAIClientForTests: vi.fn(),
}));

const { parseAttachments, processAttachments } = await import(
  '../../src/lib/attachment-processor.js'
);
const { transcribeAudio, describeImage } = await import('../../src/lib/openai-multimodal.js');
const mTranscribe = vi.mocked(transcribeAudio);
const mDescribe = vi.mocked(describeImage);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset global fetch — individual tests stub it as needed.
  (globalThis as { fetch?: unknown }).fetch = vi.fn();
});

function audioMsg(extra: Record<string, unknown> = {}) {
  return {
    attachments: [
      {
        id: 501,
        message_id: 90,
        file_type: 'audio',
        account_id: 1,
        extension: 'ogg',
        data_url: 'https://chat.fomo.com.ar/test/audio-501.ogg',
        thumb_url: null,
        file_size: 24576,
        ...extra,
      },
    ],
  };
}

function imageMsg(extra: Record<string, unknown> = {}) {
  return {
    attachments: [
      {
        id: 502,
        message_id: 91,
        file_type: 'image',
        account_id: 1,
        extension: 'jpg',
        data_url: 'https://chat.fomo.com.ar/test/image-502.jpg',
        thumb_url: null,
        file_size: 184320,
        ...extra,
      },
    ],
  };
}

describe('parseAttachments', () => {
  it('returns empty array when no attachments', () => {
    expect(parseAttachments({})).toEqual([]);
    expect(parseAttachments({ attachments: null })).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
  });

  it('extracts well-formed attachments', () => {
    const out = parseAttachments(audioMsg());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 501,
      fileType: 'audio',
      dataUrl: 'https://chat.fomo.com.ar/test/audio-501.ogg',
      fileSize: 24576,
      extension: 'ogg',
    });
  });

  it('skips attachments missing required fields (id or data_url)', () => {
    const out = parseAttachments({
      attachments: [
        { id: 1, file_type: 'audio' /* no data_url */ },
        { file_type: 'audio', data_url: 'https://x' /* no id */ },
        { id: 2, file_type: 'audio', data_url: 'https://ok' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(2);
  });
});

describe('processAttachments — empty input', () => {
  it('returns originalContent unchanged when no attachments', async () => {
    const result = await processAttachments({
      originalContent: 'hola',
      attachments: [],
    });
    expect(result).toEqual({
      processed: [],
      enrichedContent: 'hola',
      hasMedia: false,
    });
  });
});

describe('processAttachments — audio', () => {
  it('downloads, transcribes, and labels the audio', async () => {
    const fakeBuf = new ArrayBuffer(8);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeBuf),
    });
    mTranscribe.mockResolvedValue('hola, soy María de Acme, quiero info');

    const result = await processAttachments({
      originalContent: '',
      attachments: parseAttachments(audioMsg()),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://chat.fomo.com.ar/test/audio-501.ogg',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mTranscribe).toHaveBeenCalledOnce();
    expect(result.hasMedia).toBe(true);
    expect(result.enrichedContent).toBe(
      '[audio del cliente]: hola, soy María de Acme, quiero info',
    );
    expect(result.processed[0]?.extractedText).toBe(
      'hola, soy María de Acme, quiero info',
    );
  });

  it('emits placeholder when audio is too large (no Whisper call)', async () => {
    const result = await processAttachments({
      originalContent: '',
      attachments: parseAttachments(audioMsg({ file_size: 99 * 1024 * 1024 })),
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mTranscribe).not.toHaveBeenCalled();
    expect(result.enrichedContent).toBe('[audio del cliente, archivo demasiado grande]');
    expect(result.processed[0]?.failureReason).toBe('too_large');
  });

  it('emits placeholder when download fails', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await processAttachments({
      originalContent: '',
      attachments: parseAttachments(audioMsg()),
    });

    expect(mTranscribe).not.toHaveBeenCalled();
    expect(result.enrichedContent).toBe('[audio del cliente, no se pudo descargar]');
    expect(result.processed[0]?.failureReason).toBe('download_failed');
  });

  it('emits placeholder when Whisper returns null', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    mTranscribe.mockResolvedValue(null);

    const result = await processAttachments({
      originalContent: '',
      attachments: parseAttachments(audioMsg()),
    });

    expect(result.enrichedContent).toBe('[audio del cliente, no se pudo transcribir]');
    expect(result.processed[0]?.failureReason).toBe('whisper_failed');
  });
});

describe('processAttachments — image', () => {
  it('describes the image (no download — vision consumes the URL directly)', async () => {
    mDescribe.mockResolvedValue('Foto de un cartel con un mensaje publicitario');

    const result = await processAttachments({
      originalContent: 'Mirá esto',
      attachments: parseAttachments(imageMsg()),
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mDescribe).toHaveBeenCalledWith({
      imageUrl: 'https://chat.fomo.com.ar/test/image-502.jpg',
    });
    expect(result.hasMedia).toBe(true);
    expect(result.enrichedContent).toBe(
      'Mirá esto\n[imagen del cliente]: Foto de un cartel con un mensaje publicitario',
    );
  });

  it('emits placeholder when image is too large', async () => {
    const result = await processAttachments({
      originalContent: '',
      attachments: parseAttachments(imageMsg({ file_size: 50 * 1024 * 1024 })),
    });

    expect(mDescribe).not.toHaveBeenCalled();
    expect(result.enrichedContent).toBe('[imagen del cliente, archivo demasiado grande]');
  });

  it('emits placeholder when vision returns null', async () => {
    mDescribe.mockResolvedValue(null);

    const result = await processAttachments({
      originalContent: '',
      attachments: parseAttachments(imageMsg()),
    });

    expect(result.enrichedContent).toBe('[imagen del cliente, no se pudo describir]');
    expect(result.processed[0]?.failureReason).toBe('vision_failed');
  });
});

describe('processAttachments — unsupported types', () => {
  it('marks video as OTHER and does not pollute enrichedContent', async () => {
    const result = await processAttachments({
      originalContent: 'mirá',
      attachments: parseAttachments({
        attachments: [
          {
            id: 503,
            file_type: 'video',
            data_url: 'https://chat.fomo.com.ar/test/v.mp4',
            file_size: 1024,
            extension: 'mp4',
          },
        ],
      }),
    });

    expect(mTranscribe).not.toHaveBeenCalled();
    expect(mDescribe).not.toHaveBeenCalled();
    expect(result.processed[0]?.category).toBe('OTHER');
    expect(result.hasMedia).toBe(false); // OTHER does NOT count as supported media
    expect(result.enrichedContent).toBe('mirá'); // OTHER does NOT add a placeholder line
  });
});

describe('processAttachments — mixed', () => {
  it('processes audio + image in one message and combines content', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    mTranscribe.mockResolvedValue('saludo en audio');
    mDescribe.mockResolvedValue('captura de pantalla');

    const result = await processAttachments({
      originalContent: 'hola',
      attachments: parseAttachments({
        attachments: [
          ...audioMsg().attachments,
          ...imageMsg().attachments,
        ],
      }),
    });

    expect(result.hasMedia).toBe(true);
    expect(result.enrichedContent).toBe(
      'hola\n[audio del cliente]: saludo en audio\n[imagen del cliente]: captura de pantalla',
    );
  });
});
