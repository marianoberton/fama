import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const upsertTwentyLead = createTool({
  id: 'upsert-twenty-lead',
  description:
    'Registra o actualiza un lead en el CRM (Twenty). Usar cuando el backoffice cerró el discovery y conviene guardar el contacto para seguimiento.',
  inputSchema: z.object({
    name: z.string().optional().describe('Nombre del contacto si lo declaró.'),
    phone: z.string().min(1).describe('Teléfono (E.164) — campo principal de identificación.'),
    email: z.string().email().optional(),
    company: z.string().optional(),
    notes: z
      .string()
      .optional()
      .describe('Notas libres con el contexto del lead (intención, plazo, etc.).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    leadId: z.string(),
  }),
  // MOCK: integración real con Twenty CRM viene en v2.
  execute: async (input) => {
    // MOCK: upsert-twenty-lead
    console.log('// MOCK: upsert-twenty-lead', input);
    return { success: true, leadId: `mock-${Date.now()}` };
  },
});
