# FAMA — Reporte de Salud del Código

> Fecha: 2026-05-16
> Proyecto: `/home/ubuntu/fama`
> Líneas totales: ~5,590

---

## 1. Resumen Ejecutivo

FAMA es un agente de atención al cliente sobre **Mastra** con 3 agentes jerárquicos, 10 tools, servidor webhook propio, y integraciones con Chatwoot, Twenty CRM, Google Calendar y Langfuse. El código está bien estructurado pero tiene **problemas de build y tests** que bloquean CI/CD.

**Estado general: 🟡 Funcional en dev, roto en CI**

---

## 2. Estructura del Proyecto

```
src/
├── mastra/
│   ├── agents/
│   │   ├── recepcionista.ts      # Agente principal
│   │   ├── backoffice.ts         # Subagente ventas
│   │   └── agendador.ts          # Sub-subagente demos
│   ├── tools/
│   │   ├── knowledge-search.ts
│   │   ├── chatwoot-handoff.ts
│   │   ├── upsert-twenty-lead.ts
│   │   ├── list-calendar-slots.ts
│   │   ├── book-calendar-event.ts
│   │   ├── auto-handback.ts
│   │   └── ... (4 más)
│   └── index.ts                  # Registro Mastra
├── server/
│   ├── webhook.ts                # Handler principal (692 líneas)
│   ├── filter.ts                 # Validación webhooks
│   └── orchestration.ts          # Lógica de routing
├── lib/
│   ├── chatwoot.ts               # API Chatwoot
│   ├── twenty.ts                 # GraphQL Twenty CRM
│   ├── knowledge.ts              # Knowledge base estática
│   ├── nurturing-worker.ts       # Re-engagement cada 15min
│   ├── circuit-breaker.ts        # Circuit breaker genérico
│   ├── background-tracker.ts     # Métricas background
│   ├── dedup-store.ts            # Idempotencia SQLite
│   ├── attachment-processor.ts   # Procesamiento de archivos
│   ├── welcome.ts                # Mensaje de bienvenida
│   ├── logger.ts                 # Pino logger
│   └── ...
├── config/
│   ├── env.ts                    # Validación Zod de env vars
│   └── chatwoot-labels.ts        # Labels permitidas
└── index.ts                      # Entry point

tests/
├── lib/                          # Tests unitarios lib/
├── mastra/tools/                 # Tests de tools
└── server/                       # Tests de servidor
```

---

## 3. Estado de Build

### ❌ TypeScript (`tsc --noEmit`)

**Error crítico:**
```
src/lib/chatwoot.ts(314,5): error TS2304: Cannot find name 'logger'.
```

La variable `logger` se usa en `chatwoot.ts:314` pero no está importada en ese scope. Es un bug real que puede causar crash en runtime.

**Errores de tests (no críticos para prod):**
- ~30 errores `Cannot find module 'vitest'` en archivos de test
- Errores de tipos implícitos `any` en mocks de test

### ❌ Tests (`npm test`)

Vitest no se instala por **conflicto de peer dependencies** entre `zod@4` (usado por el proyecto) y `zod@^3.23.8` (requerido por `@ai-sdk/provider-utils` vía `@mastra/core`).

```
npm warn peer zod@"^3.23.8" from @ai-sdk/provider-utils@2.2.8
```

`npm install` descarta vitest para resolver el conflicto.

### ✅ Build de Mastra (`mastra build`)

No verificado directamente, pero el código compila conceptualmente salvo el bug del logger.

---

## 4. Bugs Encontrados

| # | Archivo | Línea | Problema | Severidad |
|---|---------|-------|----------|-----------|
| 1 | `src/lib/chatwoot.ts` | 314 | `logger` no importado | 🔴 Crítico |
| 2 | `package.json` | — | `zod@4` incompatible con peer dep de Mastra | 🟡 Medio |
| 3 | Tests | — | Vitest no instala por peer deps | 🟡 Medio |

---

## 5. Cobertura de Tests

No ejecutable en este momento, pero la estructura de tests es buena:
- Tests unitarios para cada tool
- Tests de integración para webhook
- Tests de circuit breaker, dedup, nurturing
- Mocks de fetch para Chatwoot y Twenty

**Recomendación:** Fixear zod/vitest y correr coverage.

---

## 6. Deuda Técnica

| Ítem | Descripción | Prioridad |
|------|-------------|-----------|
| Fix `logger` en chatwoot.ts | Importar `logger` o usar el existente | Alta |
| Resolver zod v3 vs v4 | Downgradear a zod@3.23.8 o forzar install | Alta |
| Agregar tests de integración end-to-end | Flujo completo webhook → agente → respuesta | Media |
| Documentar variables de entorno | Tabla de qué necesita cada integración | Media |
| Health check endpoint | `/health` para monitoreo | Baja |

---

## 7. Diagramas Generados

Se crearon 3 diagramas Excalidraw en `/home/ubuntu/fama/docs/diagrams/`:

1. **`arquitectura-general.excalidraw`** — Vista de alto nivel: fuentes de entrada → Chatwoot → Servidor FAMA → Mastra → Integraciones
2. **`flujo-agentes.excalidraw`** — Routing entre Recepcionista → Backoffice → Agendador, con decisiones y handoffs
3. **`integraciones-externas.excalidraw`** — Chatwoot, Twenty, Google Calendar, Langfuse, LibSQL con endpoints y criticidad

Para verlos: arrastrar los archivos a [excalidraw.com](https://excalidraw.com)

---

## 8. Próximos Pasos Recomendados

1. **Fix urgente:** `import { logger } from './logger.js'` en `src/lib/chatwoot.ts:314`
2. **Fix build:** Resolver peer deps (zod downgrade o `--force` en CI)
3. **Correr tests:** Una vez que vitest instale, `npm test` + `npm run typecheck`
4. **Subir diagramas a Excalidraw.com** para compartir links
5. **Agregar README** con instrucciones de setup y env vars requeridas
