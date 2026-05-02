import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

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
  // TODO Day 4: implementar búsqueda real sobre src/knowledge/*.md
  // (identity, employees, pricing, services, faqs, sales). Probable approach:
  // cargar y chunkear los markdowns al boot, indexar con un retriever simple
  // (BM25 o embeddings + cosine), devolver top-K por score.
  execute: async () => {
    return { results: [] };
  },
});
