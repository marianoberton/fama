import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const delegateToBackoffice = createTool({
  id: 'delegate-to-backoffice',
  description:
    'Delega la conversación al agente de Backoffice cuando se identifica intención de venta clara (capacitación, empleados de IA o consultoría). El Backoffice decide si escalar a humano, registrar lead o notificar.',
  inputSchema: z.object({
    summary: z
      .string()
      .min(1)
      .describe(
        'Resumen breve de la conversación hasta ahora (qué pidió el cliente, en qué quedamos).',
      ),
    intent: z
      .enum(['venta-capacitacion', 'venta-agentes', 'venta-consultoria'])
      .describe('Tipo de intención de venta detectada.'),
    collectedContext: z
      .record(z.string(), z.unknown())
      .describe(
        'Datos relevantes recolectados durante el discovery (nombre, empresa, cantidad, presupuesto, plazo, etc.).',
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    delegated: z.boolean(),
  }),
  // TODO Day 2: invocar al agente backoffice con el contexto recolectado.
  // El backoffice continúa la conversación usando knowledge-search,
  // chatwoot-handoff, upsert-twenty-lead y notify-mariano según corresponda.
  execute: async () => {
    return { success: true, delegated: true };
  },
});
