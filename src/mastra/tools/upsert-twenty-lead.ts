import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

export const TWENTY_LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'MEETING',
  'PROPOSAL',
  'WON',
  'LOST',
] as const;

export const TWENTY_LEAD_SOURCES = ['whatsapp', 'web', 'telegram', 'otro'] as const;

export const upsertTwentyLeadInput = z.object({
  name: z.string().optional().describe('Nombre del contacto si lo declaró.'),
  phone: z.string().min(1).describe('Teléfono (E.164) — campo principal de identificación.'),
  email: z.string().email().optional(),
  company: z.string().optional(),
  stage: z
    .enum(TWENTY_LEAD_STAGES)
    .describe(
      'Estado del lead en el embudo. NEW = recién entró sin discovery; CONTACTED = lead a explorar; MEETING = caliente o pidió demo; PROPOSAL = ya hablaron de propuesta; WON/LOST = cerrado.',
    ),
  source: z
    .enum(TWENTY_LEAD_SOURCES)
    .default('whatsapp')
    .describe('Canal por el que llegó el lead.'),
  notes: z
    .string()
    .optional()
    .describe('Notas libres con el contexto del lead (intención, plazo, etc.).'),
});

export const upsertTwentyLeadOutput = z.object({
  success: z.boolean(),
  leadId: z.string(),
});

export const upsertTwentyLead = createTool({
  id: 'upsert-twenty-lead',
  description:
    'Registra o actualiza un lead en el CRM (Twenty). Usar después de cerrar el discovery del backoffice o cuando el worker NURTURING marca un lead como LOST. Stage es enum: NEW | CONTACTED | MEETING | PROPOSAL | WON | LOST.',
  inputSchema: upsertTwentyLeadInput,
  outputSchema: upsertTwentyLeadOutput,
  // MOCK: integración real con Twenty CRM viene en v2. Mantenemos el contrato
  // real (stage + source) para que cuando se conecte no haya que rehacer prompts.
  execute: async (input) => {
    // MOCK: upsert-twenty-lead — log estructurado para que el grep en prod sirva
    logger.info({ mockTool: 'upsert-twenty-lead', input }, '// MOCK: upsert-twenty-lead');
    return { success: true, leadId: `mock-${Date.now()}` };
  },
});
