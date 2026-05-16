# FAMA Scaffold Template

Estructura de directorios y archivos base para replicar FAMA en un nuevo proyecto.

```
{{project_name}}/
├── src/
│   ├── mastra/
│   │   ├── agents/
│   │   │   ├── recepcionista.ts          # Agente principal
│   │   │   ├── backoffice.ts             # Subagente ventas
│   │   │   └── agendador.ts              # Sub-subagente demos (opcional)
│   │   ├── tools/
│   │   │   ├── knowledge-search.ts
│   │   │   ├── chatwoot-handoff.ts
│   │   │   ├── upsert-twenty-lead.ts
│   │   │   ├── list-calendar-slots.ts
│   │   │   ├── book-calendar-event.ts
│   │   │   └── auto-handback.ts
│   │   └── index.ts                      # Registro Mastra
│   ├── server/
│   │   ├── webhook.ts                    # Handler principal
│   │   ├── filter.ts                     # Validación webhooks
│   │   └── orchestration.ts              # Lógica de routing
│   ├── lib/
│   │   ├── chatwoot.ts                   # API Chatwoot
│   │   ├── twenty.ts                     # GraphQL Twenty CRM
│   │   ├── knowledge.ts                  # Knowledge base
│   │   ├── nurturing-worker.ts           # Re-engagement
│   │   ├── circuit-breaker.ts            # Circuit breaker genérico
│   │   ├── background-tracker.ts         # Métricas
│   │   ├── dedup-store.ts                # Idempotencia
│   │   ├── attachment-processor.ts       # Archivos adjuntos
│   │   ├── welcome.ts                    # Mensaje de bienvenida
│   │   ├── logger.ts                     # Pino logger
│   │   ├── business-hours.ts             # Horario AR
│   │   └── known-customer.ts             # Detección cliente conocido
│   ├── config/
│   │   ├── env.ts                        # Validación Zod
│   │   └── chatwoot-labels.ts            # Labels válidas
│   └── index.ts                          # Entry point
├── tests/
│   ├── lib/
│   ├── mastra/tools/
│   └── server/
├── docs/
│   ├── diagrams/                         # Excalidraw files
│   └── specs/                            # Specs técnicos
├── src/knowledge/                        # Markdown files
│   ├── identity.md
│   ├── employees.md
│   ├── pricing.md
│   ├── services.md
│   ├── faqs.md
│   └── sales.md
├── .env.example
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── Dockerfile
```

## Archivos mínimos para arrancar

1. `package.json` — dependencias Mastra + server
2. `src/config/env.ts` — validación de variables
3. `src/server/webhook.ts` — handler HTTP
4. `src/mastra/agents/recepcionista.ts` — agente mínimo
5. `src/mastra/tools/knowledge-search.ts` — tool mínima
6. `src/lib/chatwoot.ts` — cliente HTTP para Chatwoot
7. `src/lib/logger.ts` — logger
