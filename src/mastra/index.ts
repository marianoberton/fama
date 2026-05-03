import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { recepcionista } from './agents/recepcionista.js';
import { backoffice } from './agents/backoffice.js';
import { handleChatwootWebhook } from '../server/webhook.js';
import { loadEnv } from '../config/env.js';
import { startNurturingWorker } from '../lib/nurturing-worker.js';
import { initDedupTable, cleanupOldEntries } from '../lib/dedup-store.js';
import { logger } from '../lib/logger.js';

// Validate env at startup so a misconfigured deploy fails fast and loud,
// not on the first incoming webhook.
const env = loadEnv();

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 min — enough to absorb Chatwoot retries.
const DEDUP_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 min between sweeps.

// Background workers — same gating pattern as NURTURING. Tests stay quiet so
// background ticks don't pollute assertions.
if (env.NODE_ENV !== 'test') {
  try {
    startNurturingWorker();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to start NURTURING worker');
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
  logger.info(
    { ttlMs: DEDUP_TTL_MS, intervalMs: DEDUP_CLEANUP_INTERVAL_MS },
    'dedup cleanup worker started',
  );
}

export const mastra = new Mastra({
  agents: { recepcionista, backoffice },
  server: {
    apiRoutes: [
      // Note: Mastra ya expone GET /health built-in que devuelve {success:true}.
      // Lo usamos directamente para el healthcheck del container — no hace falta
      // route propia.
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
