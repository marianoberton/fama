import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const notifyMariano = createTool({
  id: 'notify-mariano',
  description:
    'Envía una notificación a Mariano (vía Telegram) sobre eventos relevantes — leads calientes, urgencias, oportunidades grandes. Usar con criterio, no para cada conversación.',
  inputSchema: z.object({
    message: z.string().min(1).describe('Mensaje claro y accionable para Mariano.'),
    urgency: z
      .enum(['low', 'normal', 'high'])
      .optional()
      .default('normal')
      .describe('Nivel de urgencia. high = interrumpí; low = puede esperar.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  // MOCK: integración real con Telegram viene en v2.
  execute: async (input) => {
    // MOCK: notify-mariano
    console.log('// MOCK: notify-mariano', input);
    return { success: true };
  },
});
