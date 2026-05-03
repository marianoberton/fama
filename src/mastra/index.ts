import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { recepcionista } from './agents/recepcionista.js';
import { backoffice } from './agents/backoffice.js';
import { handleChatwootWebhook } from '../server/webhook.js';
import { loadEnv } from '../config/env.js';
import { startNurturingWorker } from '../lib/nurturing-worker.js';
import { logger } from '../lib/logger.js';

// Validate env at startup so a misconfigured deploy fails fast and loud,
// not on the first incoming webhook.
const env = loadEnv();

// NURTURING worker — fires every 15 min in dev/prod. Tests start it manually
// with a faked clock + interval to avoid background ticks polluting assertions.
if (env.NODE_ENV !== 'test') {
  try {
    startNurturingWorker();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to start NURTURING worker');
  }
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
