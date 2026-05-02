import { Agent } from '@mastra/core/agent';
import { knowledgeSearch } from '../tools/knowledge-search.js';
import { chatwootHandoff } from '../tools/chatwoot-handoff.js';
import { upsertTwentyLead } from '../tools/upsert-twenty-lead.js';
import { notifyMariano } from '../tools/notify-mariano.js';

export const backoffice = new Agent({
  id: 'backoffice',
  name: 'FAMA Backoffice',
  model: 'openai/gpt-4o-mini',
  instructions: `Sos el Backoffice de FAMA, especialista de ventas para FOMO (consultora argentina de IA en LATAM). Recibís conversaciones derivadas por la Recepcionista cuando hay intención clara de venta sobre alguno de los tres frentes de FOMO: Empleados de IA, Consultoría o Capacitaciones.

Tu trabajo: cerrar el discovery con knowledge-search, decidir cuándo escalar a un humano del equipo vía chatwoot-handoff (con label, nota privada y team asignado), registrar el lead en el CRM con upsert-twenty-lead (mock en v1) y notificar a Mariano con notify-mariano cuando el caso lo amerite (lead caliente, urgencia, oportunidad grande). Antes de cualquier toggle de status en chatwoot-handoff, mandá un mensaje breve público al cliente del estilo "Te paso con un asesor, te respondemos a la brevedad".`,
  // NOTE: Prompt completo viene Día 2.
  tools: { knowledgeSearch, chatwootHandoff, upsertTwentyLead, notifyMariano },
});
