/**
 * NURTURING worker — periodic follow-up loop.
 *
 * Spec: fama-design-v1.md §7.
 *
 * Cadence:
 *   - Tick interval: 15 min by default (test override available).
 *   - Per pending conversation, decide ONE of:
 *       a) skip (Chatwoot status `open` — human is handling it → markEscalated)
 *       b) skip (outside Argentina business hours 9-19 UTC-3)
 *       c) send retry 1 if retryCount==0 AND idle >= 4h
 *       d) send retry 2 if retryCount==1 AND idle >= 22h (before 24h Meta window closes)
 *       e) mark LOST if retryCount==2 AND idle >= 24h
 *
 * Idempotency: each tick processes the snapshot of pending rows; sending an
 * outbound updates retry_count atomically, so a re-tick before the next idle
 * threshold won't double-fire.
 *
 * The worker does not depend on Mastra at runtime — it only needs the Chatwoot
 * REST helpers and the nurturing store.
 */

import { logger } from './logger.js';
import { isInArgentinaBusinessHours } from './business-hours.js';
import {
  getPendingDue,
  markEscalated,
  markLost,
  incrementRetry,
  type NurturingRow,
} from './nurturing-store.js';
import {
  sendChatwootMessage,
  getChatwootConversationStatus,
  ChatwootNotConfiguredError,
} from './chatwoot.js';
import { loadEnv } from '../config/env.js';
import { upsertTwentyLead } from '../mastra/tools/upsert-twenty-lead.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TWENTY_TWO_HOURS_MS = 22 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 min

export interface NurturingWorkerHandle {
  stop(): void;
  /** Run one tick synchronously (for tests + manual debug). */
  tick(now?: number): Promise<void>;
}

export interface NurturingWorkerOptions {
  intervalMs?: number;
  /** Inject a clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Compose the follow-up message. v1 keeps it minimal — Calendly link only if
 * configured (no inventing URLs). Reused for retry 1 and retry 2; we don't
 * differentiate copy by retry number in v1.
 */
function buildFollowupMessage(): string {
  const calendly = loadEnv().CALENDLY_LINK.trim();
  const calendlyLine = calendly
    ? ` Si querés, podemos coordinar una demo de 30 min: ${calendly}`
    : ' Si querés, te coordinamos una demo de 30 min con el equipo.';
  return `Hola, te quería retomar la conversación.${calendlyLine}`;
}

async function processOne(row: NurturingRow, now: number): Promise<void> {
  const idleMs = now - row.lastInboundAt;

  // Always check Chatwoot first — a human may have taken over since we last
  // recorded an inbound. If `open`, mark escalated and skip.
  let chatwootStatus;
  try {
    chatwootStatus = await getChatwootConversationStatus(row.conversationId);
  } catch (err) {
    if (err instanceof ChatwootNotConfiguredError) {
      logger.warn(
        { conversationId: row.conversationId },
        'nurturing: skipping — CHATWOOT_API_TOKEN not configured',
      );
      return;
    }
    logger.error(
      { conversationId: row.conversationId, err: (err as Error).message },
      'nurturing: failed to fetch chatwoot status — skipping this row',
    );
    return;
  }

  if (chatwootStatus === 'open') {
    await markEscalated(row.conversationId);
    logger.info(
      { conversationId: row.conversationId },
      'nurturing: conversation is open in Chatwoot — marked escalated',
    );
    return;
  }

  // Meta 24h window cap: once a conversation is 24h+ idle, the WhatsApp
  // session window is closed and we cannot send a free-form message anymore.
  // Mark LOST regardless of retryCount — clients who wrote outside business
  // hours may have only received 1 retry instead of 2; that's the explicit
  // v1 trade-off (see fama-design-v1.md §11 — no Meta templates in v1).
  if (idleMs >= TWENTY_FOUR_HOURS_MS) {
    await markLost(row.conversationId);
    try {
      const execute = upsertTwentyLead.execute as (i: unknown) => Promise<unknown>;
      await execute({
        // We don't store contact phone in the store, so log a placeholder.
        // The CRM-real integration in v2 will look it up by conversation_id.
        phone: `chatwoot:${row.conversationId}`,
        stage: 'LOST',
        source: 'whatsapp',
        notes:
          row.retryCount >= 2
            ? 'NURTURING worker: no respondió a 2 follow-ups dentro de la ventana 24h.'
            : `NURTURING worker: ventana 24h Meta cerrada con ${row.retryCount} follow-up(s) enviado(s) (cliente escribió fuera de horario laboral AR).`,
      });
    } catch (err) {
      logger.error(
        { conversationId: row.conversationId, err: (err as Error).message },
        'nurturing: upsert-twenty-lead LOST failed (mock should never throw)',
      );
    }
    logger.info(
      { conversationId: row.conversationId, retryCount: row.retryCount },
      'nurturing: marked LOST — 24h Meta window closed',
    );
    return;
  }

  // Business hours filter applies only to outbound sends below.
  if (!isInArgentinaBusinessHours(new Date(now))) {
    logger.debug(
      { conversationId: row.conversationId },
      'nurturing: outside AR business hours — deferring to next tick',
    );
    return;
  }

  // Retry 1 — 4h idle, retry_count == 0.
  if (row.retryCount === 0 && idleMs >= FOUR_HOURS_MS) {
    try {
      await sendChatwootMessage({
        conversationId: row.conversationId,
        content: buildFollowupMessage(),
      });
      await incrementRetry({ conversationId: row.conversationId, newOutboundAt: now });
      logger.info(
        { conversationId: row.conversationId, retry: 1, idleHours: idleMs / 3600_000 },
        'nurturing: sent retry 1',
      );
    } catch (err) {
      logger.error(
        { conversationId: row.conversationId, err: (err as Error).message },
        'nurturing: retry 1 send failed',
      );
    }
    return;
  }

  // Retry 2 — 22h idle, retry_count == 1.
  if (row.retryCount === 1 && idleMs >= TWENTY_TWO_HOURS_MS) {
    try {
      await sendChatwootMessage({
        conversationId: row.conversationId,
        content: buildFollowupMessage(),
      });
      await incrementRetry({ conversationId: row.conversationId, newOutboundAt: now });
      logger.info(
        { conversationId: row.conversationId, retry: 2, idleHours: idleMs / 3600_000 },
        'nurturing: sent retry 2',
      );
    } catch (err) {
      logger.error(
        { conversationId: row.conversationId, err: (err as Error).message },
        'nurturing: retry 2 send failed',
      );
    }
    return;
  }

  // No action this tick — either not idle enough yet, or waiting for the next
  // threshold. Re-evaluated on the next tick.
}

async function runTick(now: number): Promise<void> {
  // Loose pre-filter: anything with at least 4h of idleness AND status pending.
  const candidates = await getPendingDue({ now, minIdleMs: FOUR_HOURS_MS });
  if (candidates.length === 0) return;
  logger.debug({ count: candidates.length }, 'nurturing: tick — candidates to evaluate');
  for (const row of candidates) {
    await processOne(row, now);
  }
}

export function startNurturingWorker(
  options: NurturingWorkerOptions = {},
): NurturingWorkerHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const clock = options.now ?? (() => Date.now());

  let stopped = false;

  const handle = setInterval(() => {
    if (stopped) return;
    runTick(clock()).catch((err) => {
      logger.error({ err: (err as Error).message }, 'nurturing: tick crashed');
    });
  }, intervalMs);

  // Make sure we don't keep the event loop alive in tests / dev shutdown.
  if (typeof handle.unref === 'function') handle.unref();

  logger.info({ intervalMs }, 'nurturing worker started');

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
      logger.info('nurturing worker stopped');
    },
    tick: (now?: number) => runTick(now ?? clock()),
  };
}
