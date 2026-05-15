/**
 * Auto-handback worker — periodically flips idle `open` conversations back to
 * `pending` so the bot can resume handling them.
 *
 * Context: when the bot escalates a conversation to a human (`toggle_status:
 * open`), Chatwoot changes the status to `open`. If no human attends within
 * INACTIVITY_THRESHOLD_MS, the conversation stays stuck — the bot won't process
 * new messages (filter rule 3: only `pending`), and the customer gets no reply.
 *
 * This worker scans the inbox every TICK_INTERVAL_MS, finds conversations that
 * have been `open` with no activity for longer than the threshold, and flips
 * them back to `pending` so the bot resumes on the next incoming message.
 *
 * Safety: the threshold defaults to 30 min. A human actively typing will
 * generate activity (last_activity_at updates) that keeps the conversation
 * above the threshold. The flip only happens for genuinely idle conversations.
 */

import { logger } from './logger.js';
import {
  listConversationsByStatus,
  toggleChatwootStatus,
  ChatwootNotConfiguredError,
} from './chatwoot.js';
import { loadEnv } from '../config/env.js';

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 min

export interface AutoHandbackWorkerOptions {
  tickIntervalMs?: number;
  inactivityThresholdMs?: number;
  /** Inject a clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface AutoHandbackWorkerHandle {
  stop(): void;
  /** Run one tick synchronously (for tests + manual debug). */
  tick(now?: number): Promise<void>;
}

async function runTick(now: number, inactivityThresholdMs: number): Promise<void> {
  const env = loadEnv();

  const conversations = await listConversationsByStatus({
    status: 'open',
    inboxId: env.CHATWOOT_INBOX_ID,
  });

  if (conversations.length === 0) return;

  let flipped = 0;
  for (const conv of conversations) {
    const idleMs = now - conv.lastActivityAtMs;
    if (idleMs < inactivityThresholdMs) continue;

    try {
      await toggleChatwootStatus({ conversationId: conv.id, status: 'pending' });
      logger.info(
        {
          conversationId: conv.id,
          idleMin: Math.round(idleMs / 60_000),
          thresholdMin: Math.round(inactivityThresholdMs / 60_000),
        },
        'auto-handback: flipped open → pending (idle conversation)',
      );
      flipped++;
    } catch (err) {
      logger.error(
        { err: (err as Error).message, conversationId: conv.id },
        'auto-handback: toggle_status failed',
      );
    }
  }

  logger.info(
    { scanned: conversations.length, flipped },
    'auto-handback: tick complete',
  );
}

export function startAutoHandbackWorker(
  options: AutoHandbackWorkerOptions = {},
): AutoHandbackWorkerHandle {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const inactivityThresholdMs =
    options.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS;
  const clock = options.now ?? (() => Date.now());

  let stopped = false;

  const handle = setInterval(() => {
    if (stopped) return;
    runTick(clock(), inactivityThresholdMs).catch((err) => {
      if (err instanceof ChatwootNotConfiguredError) {
        logger.debug('auto-handback: CHATWOOT_API_TOKEN not configured — skipping tick');
        return;
      }
      logger.error({ err: (err as Error).message }, 'auto-handback: tick crashed');
    });
  }, tickIntervalMs);

  if (typeof handle.unref === 'function') handle.unref();

  logger.info(
    { tickIntervalMs, inactivityThresholdMs },
    'auto-handback worker started',
  );

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
      logger.info('auto-handback worker stopped');
    },
    tick: (now?: number) => runTick(now ?? clock(), inactivityThresholdMs),
  };
}
