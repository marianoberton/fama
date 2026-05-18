import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { recepcionista } from './agents/recepcionista.js';
import { backoffice } from './agents/backoffice.js';
import { agendador } from './agents/agendador.js';
import { handleChatwootWebhook } from '../server/webhook.js';
import { loadEnv } from '../config/env.js';
import { startNurturingWorker } from '../lib/nurturing-worker.js';
import { startAutoHandbackWorker } from '../lib/auto-handback-worker.js';
import { initDedupTable, cleanupOldEntries } from '../lib/dedup-store.js';
import { buildObservability } from './observability.js';
import {
  pendingBackgroundCount,
  waitForBackgroundDrain,
} from '../lib/background-tracker.js';
import { logger } from '../lib/logger.js';
import { collectMetrics } from '../lib/metrics.js';

// Validate env at startup so a misconfigured deploy fails fast and loud,
// not on the first incoming webhook.
const env = loadEnv();

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 min — enough to absorb Chatwoot retries.
const DEDUP_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 min between sweeps.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000; // 10s max to drain background tasks.

// Worker handles collected at startup so graceful shutdown can stop them.
interface WorkerHandle {
  name: string;
  stop: () => void;
}
const workerHandles: WorkerHandle[] = [];

// Background workers — same gating pattern as NURTURING. Tests stay quiet so
// background ticks don't pollute assertions.
if (env.NODE_ENV !== 'test') {
  try {
    const nurturing = startNurturingWorker();
    workerHandles.push({ name: 'nurturing', stop: () => nurturing.stop() });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to start NURTURING worker');
  }

  try {
    const autoHandback = startAutoHandbackWorker();
    workerHandles.push({ name: 'auto-handback', stop: () => autoHandback.stop() });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to start auto-handback worker');
  }

  // Dedup cleanup: ensures `processed_messages` doesn't grow unbounded.
  initDedupTable().catch((err) => {
    logger.error({ err: (err as Error).message }, 'dedup: initDedupTable failed at startup');
  });
  const dedupHandle = setInterval(() => {
    cleanupOldEntries(DEDUP_TTL_MS).catch((err) => {
      logger.error({ err: (err as Error).message }, 'dedup: cleanup tick failed');
    });
  }, DEDUP_CLEANUP_INTERVAL_MS);
  if (typeof dedupHandle.unref === 'function') dedupHandle.unref();
  workerHandles.push({
    name: 'dedup-cleanup',
    stop: () => clearInterval(dedupHandle),
  });
  logger.info(
    { ttlMs: DEDUP_TTL_MS, intervalMs: DEDUP_CLEANUP_INTERVAL_MS },
    'dedup cleanup worker started',
  );
}

export const mastra = new Mastra({
  agents: { recepcionista, backoffice, agendador },
  observability: buildObservability(),
  server: {
    apiRoutes: [
      // Note: Mastra ya expone GET /health built-in que devuelve {success:true}.
      // Lo usamos directamente para el healthcheck del container — no hace falta
      // route propia.
      registerApiRoute('/metrics', {
        method: 'GET',
        requiresAuth: false,
        handler: async (c) => {
          const metrics = await collectMetrics();
          return c.json(metrics, 200);
        },
      }),
      registerApiRoute('/v1/webhooks/chatwoot/:token', {
        method: 'POST',
        requiresAuth: false,
        handler: async (c) => {
          const outcome = await handleChatwootWebhook({
            pathToken: c.req.param('token'),
            rawBody: await c.req.text(),
            mastra: c.get('mastra'),
          });
          return c.json(outcome.body, outcome.status);
        },
      }),
    ],
  },
});

// Graceful shutdown: when Docker / Dockploy sends SIGTERM, stop workers, drain
// in-flight webhook background tasks, flush observability and exit cleanly.
// Without this a deploy mid-tick can leave a NURTURING row half-updated or
// lose pending Langfuse spans.
let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'graceful-shutdown: received');

  for (const handle of workerHandles) {
    try {
      handle.stop();
    } catch (err) {
      logger.error(
        { err: (err as Error).message, name: handle.name },
        'graceful-shutdown: worker stop failed',
      );
    }
  }

  if (pendingBackgroundCount() > 0) {
    logger.info(
      { pending: pendingBackgroundCount(), timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
      'graceful-shutdown: draining background tasks',
    );
    await waitForBackgroundDrain(SHUTDOWN_DRAIN_TIMEOUT_MS);
  }

  try {
    if (mastra.observability) {
      await mastra.observability.shutdown();
      logger.info('graceful-shutdown: observability flushed');
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'graceful-shutdown: observability flush failed',
    );
  }

  logger.info('graceful-shutdown: complete');
  process.exit(0);
}

if (env.NODE_ENV !== 'test') {
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}
