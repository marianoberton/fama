import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CHATWOOT_VALID_LABELS } from '../../config/chatwoot-labels.js';

/*
 * chatwoot-handoff — escala una conversación a un humano del equipo.
 *
 * TODO Day 3: implementación real. Debe ejecutar 4 llamadas a la API de
 * Chatwoot **en este orden** (el orden importa: la automation rule de
 * Chatwoot reacciona a `status=open` con team asignado, así que la metadata
 * tiene que estar cargada antes del toggle):
 *
 *   1. POST /api/v1/accounts/{accountId}/conversations/{conversationId}/labels
 *        body: { labels: [category] }
 *   2. POST .../messages
 *        body: { content: <reason>, private: true, message_type: 'outgoing' }
 *   3. POST .../assignments
 *        body: { team_id: CHATWOOT_TEAM_ID }
 *   4. POST .../toggle_status
 *        body: { status: 'open' }
 *
 * Reglas:
 *   - Sin retry automático en v1. Si un paso falla → log ERROR + return
 *     { success: false, step_failed: 1|2|3|4, error }.
 *   - Idempotencia: lock interno en memoria por conversationId. Si la misma
 *     conversación fue handoffeada en los últimos 60s → skip (no-op,
 *     return { success: true, step_failed: null }).
 *   - El parámetro `category` ya viene validado contra CHATWOOT_VALID_LABELS
 *     por el schema (z.enum). Cualquier label fuera de la lista falla en
 *     validación antes de tocar a Chatwoot.
 *
 * Template esperado para `reason` (lo arma el backoffice):
 *   Categoría: <category>
 *   Motivo: <razón en 1-3 oraciones>
 *   Cliente: <nombre si lo dijo, sino "no identificado">
 *   Empresa: <si aplica, sino "no mencionada">
 *   Datos clave: <ej: cantidad, presupuesto, plazo>
 */

export const chatwootHandoff = createTool({
  id: 'chatwoot-handoff',
  description:
    'Escala la conversación de Chatwoot a un humano del equipo: aplica label, deja nota privada con contexto, asigna al team y abre la conversación. Usar cuando el cliente pide hablar con persona, hay urgencia/reclamo, o se cerró una venta y hay que pasarla al humano.',
  inputSchema: z.object({
    conversationId: z
      .number()
      .int()
      .positive()
      .describe('ID de la conversación en Chatwoot.'),
    category: z
      .enum(CHATWOOT_VALID_LABELS)
      .describe(
        'Label de Chatwoot. Debe ser una de las labels válidas creadas en la cuenta.',
      ),
    reason: z
      .string()
      .min(1)
      .describe(
        'Texto de la nota privada con el contexto (Categoría / Motivo / Cliente / Empresa / Datos clave).',
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    step_failed: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]),
    error: z.string().optional(),
  }),
  execute: async () => {
    return { success: true, step_failed: null };
  },
});
