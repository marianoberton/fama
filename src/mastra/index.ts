import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { recepcionista } from './agents/recepcionista.js';
import { backoffice } from './agents/backoffice.js';
import { handleChatwootWebhook } from '../server/webhook.js';
import { loadEnv } from '../config/env.js';

// Validate env at startup so a misconfigured deploy fails fast and loud,
// not on the first incoming webhook.
loadEnv();

export const mastra = new Mastra({
  agents: { recepcionista, backoffice },
  server: {
    apiRoutes: [
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
