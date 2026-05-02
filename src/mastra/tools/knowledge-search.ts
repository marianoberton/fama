import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { searchKnowledge } from '../../lib/knowledge.js';

export const knowledgeSearch = createTool({
  id: 'knowledge-search',
  description:
    'Busca información sobre FOMO (servicios, empleados de IA, precios, FAQs, propuesta de valor) en la knowledge base interna. Usar cuando el cliente pregunta algo concreto sobre la empresa, productos o condiciones comerciales.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Texto de búsqueda en lenguaje natural'),
    limit: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .default(5)
      .describe('Cantidad máxima de resultados (default 5)'),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        content: z.string(),
        source: z.string(),
      }),
    ),
  }),
  execute: async ({ query, limit }) => {
    const results = searchKnowledge(query, limit);
    return { results };
  },
});
