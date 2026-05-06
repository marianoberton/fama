/**
 * Thin wrappers around OpenAI's Whisper (audio transcription) and gpt-4o
 * vision (image description) APIs. The rest of FAMA only consumes text — these
 * helpers convert media into text so the existing pipeline (recepcionista +
 * backoffice) keeps treating every input as a string.
 *
 * Both helpers are fail-soft: on error they return `null` and log. The caller
 * (attachment-processor) decides what to do — usually fall through to the LLM
 * with a generic "[audio inaudible]" / "[imagen ilegible]" placeholder so the
 * conversation continues instead of crashing.
 */

import OpenAI from 'openai';
import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

let cached: OpenAI | undefined;

function client(): OpenAI {
  if (cached) return cached;
  const apiKey = loadEnv().OPENAI_API_KEY;
  cached = new OpenAI({ apiKey });
  return cached;
}

/** Test-only: clear the cached client so a re-import picks up new env. */
export function _resetOpenAIClientForTests(): void {
  cached = undefined;
}

/**
 * Transcribes an audio blob using Whisper. The OpenAI SDK expects a `File` /
 * `Blob` with a name — we wrap a Buffer into a File via the SDK's `toFile`
 * helper so multipart upload works regardless of whether the buffer came from
 * fetch() or fs.
 *
 * Returns the trimmed transcription, or null on any failure.
 */
export async function transcribeAudio(input: {
  audio: Buffer;
  /** Filename including extension — Whisper needs the extension to pick the codec. */
  filename: string;
  /** Optional language hint, e.g. 'es' for Spanish. Improves accuracy. */
  language?: string;
}): Promise<string | null> {
  try {
    const file = await OpenAI.toFile(input.audio, input.filename);
    const res = await client().audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: input.language ?? 'es',
      response_format: 'text',
    });
    // With response_format 'text' the SDK returns a plain string.
    const transcription = typeof res === 'string' ? res : (res as { text?: string }).text ?? '';
    const trimmed = transcription.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, filename: input.filename },
      'whisper: transcription failed',
    );
    return null;
  }
}

/**
 * Describes an image using gpt-4o vision. Returns a short Spanish description
 * (1-3 sentences) suitable for injecting into the agent's text input.
 *
 * gpt-4o accepts the image as a public URL (`image_url`) — no need to download
 * + base64-encode if the URL is reachable from OpenAI's servers. For Chatwoot
 * self-hosted (https://crm.fomo.com.ar/rails/active_storage/...), the URLs ARE
 * publicly reachable (signed but not auth-gated), so we pass them as-is.
 *
 * Returns the trimmed description, or null on any failure.
 */
export async function describeImage(input: {
  imageUrl: string;
  /** Optional context hint — e.g. "Es un mensaje de WhatsApp recibido por la atención al cliente". */
  context?: string;
}): Promise<string | null> {
  try {
    const prompt =
      'Describí brevemente (1-3 oraciones, en castellano rioplatense) qué se ve en esta imagen. ' +
      'Si tiene texto legible, transcribilo literal entre comillas. ' +
      'Si es un screenshot de algo (error, conversación, web), aclaralo. ' +
      'Si no se entiende qué es, decí "imagen poco clara" y describí lo que veas.' +
      (input.context ? `\n\nContexto: ${input.context}` : '');

    const res = await client().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: input.imageUrl } },
          ],
        },
      ],
    });
    const description = res.choices[0]?.message?.content ?? '';
    const trimmed = description.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, imageUrl: input.imageUrl.slice(0, 100) },
      'vision: image description failed',
    );
    return null;
  }
}
