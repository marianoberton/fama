/**
 * Pre-processing of Chatwoot attachments (audio + image) into text so the
 * existing FAMA pipeline keeps working with strings only.
 *
 * Sprint 2 design — see CLAUDE.md "Multimodalidad (v2 — Sprint 2)":
 *  - Audio (.opus / .ogg / .m4a / .mp3) → Whisper transcribes → text
 *  - Image (.jpg / .png / .webp) → gpt-4o vision describes → text
 *  - Anything else (video, document, fallback) → skipped + logged
 *  - Hard caps enforced before any OpenAI call: 60s audio (~ 1MB) and 10MB image
 *  - All fail-soft: a failed extraction yields `null` and a placeholder string
 *    in the enriched content; the conversation never crashes because of media.
 */

import { logger } from './logger.js';
import { transcribeAudio, describeImage } from './openai-multimodal.js';

/** Twenty's `fileCategory` enum — we only emit AUDIO / IMAGE / OTHER in v2. */
export type AttachmentCategory = 'AUDIO' | 'IMAGE' | 'OTHER';

export interface ChatwootRawAttachment {
  id: number;
  fileType: string; // 'audio' | 'image' | 'video' | 'file' | 'fallback'
  dataUrl: string;
  fileSize: number;
  /** Extension WITHOUT a leading dot — e.g. 'ogg', 'jpg'. May be empty. */
  extension: string;
}

export interface ProcessedAttachment {
  id: number;
  category: AttachmentCategory;
  dataUrl: string;
  /** Best-effort filename for Twenty + Whisper (e.g. 'audio-12345.ogg'). */
  filename: string;
  /** Transcription (audio) or description (image). null = extraction failed or skipped. */
  extractedText: string | null;
  /** Reason if extractedText is null — for telemetry / logs. */
  failureReason?:
    | 'too_large'
    | 'unsupported_type'
    | 'download_failed'
    | 'whisper_failed'
    | 'vision_failed'
    | 'empty_result';
}

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5MB — covers ~5min of opus, plenty of margin over 60s cap
const MAX_AUDIO_SECONDS_HINT = 60; // documented in error logs only — actual gate is bytes
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB — gpt-4o vision limit

/** Heuristic — Chatwoot's `file_type` is sometimes lower-case, sometimes upper. */
function categorise(fileType: string): AttachmentCategory {
  const lc = fileType.toLowerCase();
  if (lc === 'audio') return 'AUDIO';
  if (lc === 'image') return 'IMAGE';
  return 'OTHER';
}

/**
 * Extract attachments from a Chatwoot message payload. Tolerates both shapes:
 * the v4.12.1 nested `conversation.messages[0].attachments` and the older
 * root-level `messages[0].attachments`. Returns an empty array if none.
 */
export function parseAttachments(messageObj: unknown): ChatwootRawAttachment[] {
  if (!isObject(messageObj)) return [];
  const list = Array.isArray(messageObj['attachments']) ? messageObj['attachments'] : [];
  const result: ChatwootRawAttachment[] = [];
  for (const a of list) {
    if (!isObject(a)) continue;
    const id = typeof a['id'] === 'number' ? a['id'] : null;
    const fileType = typeof a['file_type'] === 'string' ? a['file_type'] : '';
    const dataUrl = typeof a['data_url'] === 'string' ? a['data_url'] : '';
    const fileSize = typeof a['file_size'] === 'number' ? a['file_size'] : 0;
    const extension = typeof a['extension'] === 'string' ? a['extension'] : '';
    if (id === null || !dataUrl) continue;
    result.push({ id, fileType, dataUrl, fileSize, extension });
  }
  return result;
}

function deriveFilename(att: ChatwootRawAttachment, category: AttachmentCategory): string {
  const ext = att.extension || (category === 'AUDIO' ? 'ogg' : category === 'IMAGE' ? 'jpg' : 'bin');
  return `chatwoot-${att.id}.${ext}`;
}

/**
 * Downloads an attachment from Chatwoot's Active Storage URL. The URL in
 * Chatwoot self-hosted is signed but publicly reachable (no auth header
 * needed). If that ever changes (auth-gated), add the api_access_token here.
 *
 * Aborts after 15s. Returns null on any failure.
 */
async function downloadAttachment(dataUrl: string): Promise<Buffer | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(dataUrl, { signal: ac.signal });
    if (!res.ok) {
      logger.warn(
        { status: res.status, urlPreview: dataUrl.slice(0, 100) },
        'attachment-processor: download non-2xx',
      );
      return null;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, urlPreview: dataUrl.slice(0, 100) },
      'attachment-processor: download failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Processes one attachment to text. Returns a ProcessedAttachment with the
 * extracted text or, on any failure, the failureReason. Never throws.
 */
async function processOne(att: ChatwootRawAttachment): Promise<ProcessedAttachment> {
  const category = categorise(att.fileType);
  const filename = deriveFilename(att, category);
  const base: ProcessedAttachment = {
    id: att.id,
    category,
    dataUrl: att.dataUrl,
    filename,
    extractedText: null,
  };

  if (category === 'OTHER') {
    logger.info(
      { id: att.id, fileType: att.fileType },
      'attachment-processor: unsupported type, skipping extraction (will still link in Twenty)',
    );
    return { ...base, failureReason: 'unsupported_type' };
  }

  if (category === 'AUDIO') {
    if (att.fileSize > MAX_AUDIO_BYTES) {
      logger.warn(
        { id: att.id, fileSize: att.fileSize, maxBytes: MAX_AUDIO_BYTES, hintSeconds: MAX_AUDIO_SECONDS_HINT },
        'attachment-processor: audio too large, skipping',
      );
      return { ...base, failureReason: 'too_large' };
    }
    const buffer = await downloadAttachment(att.dataUrl);
    if (!buffer) return { ...base, failureReason: 'download_failed' };
    const text = await transcribeAudio({ audio: buffer, filename });
    if (text === null) return { ...base, failureReason: 'whisper_failed' };
    if (text.length === 0) return { ...base, failureReason: 'empty_result' };
    return { ...base, extractedText: text };
  }

  // IMAGE
  if (att.fileSize > MAX_IMAGE_BYTES) {
    logger.warn(
      { id: att.id, fileSize: att.fileSize, maxBytes: MAX_IMAGE_BYTES },
      'attachment-processor: image too large, skipping',
    );
    return { ...base, failureReason: 'too_large' };
  }
  const text = await describeImage({ imageUrl: att.dataUrl });
  if (text === null) return { ...base, failureReason: 'vision_failed' };
  if (text.length === 0) return { ...base, failureReason: 'empty_result' };
  return { ...base, extractedText: text };
}

export interface ProcessAttachmentsResult {
  processed: ProcessedAttachment[];
  /** Concatenation of original text + extracted text per attachment, ready to feed the LLM. */
  enrichedContent: string;
  /** True if at least one supported attachment (audio/image) was found, regardless of extraction success. */
  hasMedia: boolean;
}

/**
 * Main entry point. Processes all attachments in parallel, then builds the
 * enriched content string. The order is: original text first, then a labeled
 * line per attachment.
 *
 * Examples of resulting `enrichedContent`:
 *   - audio only, OK:        "[audio del cliente]: hola, soy María de Acme..."
 *   - audio only, failed:    "[audio del cliente, no se pudo transcribir]"
 *   - text + image OK:       "Hola!\n[imagen del cliente]: foto de un cartel..."
 *   - image too large:       "Hola!\n[imagen del cliente, archivo demasiado grande]"
 */
export async function processAttachments(input: {
  originalContent: string;
  attachments: ChatwootRawAttachment[];
}): Promise<ProcessAttachmentsResult> {
  if (input.attachments.length === 0) {
    return { processed: [], enrichedContent: input.originalContent, hasMedia: false };
  }

  const processed = await Promise.all(input.attachments.map(processOne));
  const hasMedia = processed.some((p) => p.category === 'AUDIO' || p.category === 'IMAGE');

  const lines: string[] = [];
  if (input.originalContent.trim().length > 0) lines.push(input.originalContent.trim());

  for (const p of processed) {
    if (p.category === 'OTHER') continue; // unsupported types: link in Twenty but don't pollute the LLM input
    const label = p.category === 'AUDIO' ? 'audio del cliente' : 'imagen del cliente';
    if (p.extractedText !== null) {
      lines.push(`[${label}]: ${p.extractedText}`);
    } else {
      const reason =
        p.failureReason === 'too_large'
          ? 'archivo demasiado grande'
          : p.failureReason === 'download_failed'
            ? 'no se pudo descargar'
            : p.category === 'AUDIO'
              ? 'no se pudo transcribir'
              : 'no se pudo describir';
      lines.push(`[${label}, ${reason}]`);
    }
  }

  return {
    processed,
    enrichedContent: lines.join('\n'),
    hasMedia,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
