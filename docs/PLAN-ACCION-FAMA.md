# FAMA — Plan de Acción: Hermes + Claude Code

> Actualizado: 2026-05-17
> Objetivo: Definir dónde brilla cada pieza del stack y cómo se complementan

---

## 1. El Combo: Quién hace qué

### 🤖 Hermes Agent (VPS)
**Rol:** Operador del VPS, ejecutor, integrador

| Tarea | Por qué Hermes |
|-------|----------------|
| **Monitoreo en vivo** | Lee logs, ve estado de servicios, ejecuta comandos en el VPS |
| **Fixes de código pequeños** | Acceso directo al filesystem, puede editar, testear, deployar |
| **Integración de servicios** | Conecta Chatwoot, Twenty, GCal, Langfuse desde el VPS |
| **Documentación visual** | Genera diagramas Excalidraw, reportes, specs |
| **Git ops** | Commits, push, deploys |

**Limitación:** ~90 turnos por conversación. Para tareas largas delega a Claude Code.

---

### 💻 Claude Code (CLI — esta sesión)
**Rol:** Coding agent autónomo para tareas complejas

| Tarea | Por qué Claude Code |
|-------|---------------------|
| **Refactor grande** | Trabaja 30+ minutos solo, edita múltiples archivos con contexto completo |
| **Implementar features nuevas** | Agarra un spec y lo implementa end-to-end |
| **Tests** | Escribe suites de tests completas |
| **Code review** | Analiza diff, detecta bugs, sugiere mejoras |
| **Análisis de métricas y conversaciones** | Procesa logs, detecta patrones, evalúa calidad de respuestas |
| **Benchmark de modelos** | Diseña y corre comparaciones de LLMs con el eval set |
| **Generación y mejora de prompts** | Itera sobre instructions de agentes con criterio técnico |

**Fortaleza:** Tiene el CLAUDE.md cargado — conoce el negocio de FOMO, las reglas, el árbol de decisión del backoffice, todo.

---

## 2. Flujo de trabajo ideal

```
┌─────────────────────────────────────────────────────────────┐
│  MARIANO (vos)                                               │
│  "Necesito X" / "Fix Y" / "Analizá Z"                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Evaluación rápida                                           │
│  • Fix de 1 línea / ops / monitoreo → Hermes                │
│  • Feature / refactor / análisis / benchmark → Claude Code  │
└──────────────┬────────────────────────┬─────────────────────┘
               │                        │
               ▼                        ▼
        ┌──────────┐             ┌──────────────┐
        │  HERMES  │             │  CLAUDE CODE │
        │(ops, VPS,│             │(código,      │
        │ deploys, │             │ análisis,    │
        │ monitoreo│             │ benchmarks,  │
        │ rápido)  │             │ prompts)     │
        └────┬─────┘             └──────┬───────┘
             │                         │
             └────────────┬────────────┘
                          ▼
           ┌──────────────────────────┐
           │  Hermes integra y deploya│
           │  • Aplica cambios        │
           │  • Corre tests           │
           │  • Push + deploy VPS     │
           │  • Reporta a Mariano     │
           └──────────────────────────┘
```

---

## 3. Plan de acción concreto

### Fase 1: Fixes urgentes ✅ Completada
**Quién:** Hermes + Claude Code

| # | Tarea | Estado |
|---|-------|--------|
| 1 | Fix `logger` en chatwoot.ts | ✅ Hecho |
| 2 | Resolver zod peer dependency | ✅ Hecho (npmrc + versiones pinadas) |
| 3 | Pinear versiones en package.json | ✅ Hecho |
| 4 | Refactorizar webhook.ts en módulos | ✅ Hecho (6 handlers + tests) |
| 5 | Tests verdes | ✅ 275/275 |

---

### Fase 2: Observabilidad y métricas ✅ Completada
**Quién:** Claude Code para implementación + Hermes para integración VPS

| # | Tarea | Estado |
|---|-------|--------|
| 6 | Langfuse self-hosted en VPS | ✅ Código listo, pendiente setup VPS (ops Mariano) |
| 7 | Circuit breakers (LLM + Chatwoot) | ✅ Hecho |
| 8 | Graceful shutdown | ✅ Hecho |
| 9 | Eval set sistemático (5 casos canónicos) | ✅ Hecho |
| 10 | Métricas básicas: endpoint GET /metrics | ✅ Hecho (uptime, leads/día, threads, avg LLM ms, nurturing, circuit breakers) |
| 11 | Dashboard HTML | ❌ No necesario — ops usa /metrics vía browser o Chatwoot sidebar iframe |

---

### Fase 2.5: Web Chat — Elena en la web de FOMO ✅ En curso
**Objetivo:** FAMA responde mensajes de la web de fomo.com.ar además de WhatsApp. Es la base del producto Elena que FOMO vende a clientes.

**Por qué es la misma arquitectura que Elena**: cuando un cliente compra Elena, lo que recibe es una instancia de FAMA conectada a su Chatwoot con el widget embed en su web. El multi-inbox ya está implementado.

**Cambio de código completado:**
- `CHATWOOT_INBOX_ID` (número único) → `CHATWOOT_INBOX_IDS` (lista separada por comas, e.g. `"3,5"`)
- Known-customer detection ahora reconoce clientes cross-channel (WhatsApp ↔ web)
- Auto-handback worker escanea todos los inboxes configurados
- El filtro del webhook ya no necesita cambios — no filtra por inbox_id

**Pasos operacionales para Mariano (sin código):**

| Paso | Cómo | Tiempo |
|------|------|--------|
| 1. Crear inbox "Web" en Chatwoot | Settings → Inboxes → New Inbox → Website → nombre "FOMO Web" | 2 min |
| 2. Conectar agent bot al inbox | Settings → Agent Bots → FAMA → conectar al nuevo inbox | 1 min |
| 3. Anotar el nuevo inbox_id | Settings → Inboxes → ver ID del inbox creado (será 4 o el siguiente) | 30 s |
| 4. Actualizar `.env` en VPS | `CHATWOOT_INBOX_IDS=3,<nuevo_id>` (antes era `CHATWOOT_INBOX_ID=3`) | 1 min |
| 5. Reiniciar container | `docker compose up -d --force-recreate` | 1 min |
| 6. Pegar script embed en fomologic.com.ar | Copiar el `<script>` del inbox web y pegarlo en el `<head>` del sitio | 5-10 min |

**Resultado:** Visitantes de fomologic.com.ar chatean con FAMA directo. Misma lógica, mismo backoffice, mismo CRM (Twenty).

---

### Fase 3: Benchmark de modelos (próximas 2 semanas)
**Quién:** Claude Code diseña y corre + Mariano decide

| # | Tarea | Quién | Tiempo |
|---|-------|-------|--------|
| 12 | Benchmark recepcionista: gpt-4o-mini vs claude-haiku-4-5 | Claude Code | 2 hs |
| 13 | Benchmark backoffice: gpt-4o vs claude-sonnet-4-6 | Claude Code | 2 hs |
| 14 | Análisis de costo/performance/calidad | Claude Code | 30 min |
| 15 | Decisión de modelo por agente | Mariano | 30 min |

**Metodología:** Correr el eval set existente (5 casos canónicos + anti-hallucination) con cada modelo. Métricas: calidad de respuesta, tiempo, costo por conversación, tasa de handoff correcto, tasa de delegación correcta.

---

### Fase 4: Hermes como supervisor de FAMA (próximo mes)
**Quién:** Hermes implementa + Claude Code escribe el código

| # | Tarea | Quién | Tiempo |
|---|-------|-------|--------|
| 16 | Cronjob de monitoreo (logs + anomalías) | Claude Code + Hermes | 3 hs |
| 17 | Alertas proactivas (circuit breaker, errores repetidos) | Claude Code | 2 hs |
| 18 | Reporte diario de métricas | Hermes (cronjob) | 1 h |
| 19 | Sugerencias de acción a Mariano | Claude Code | 2 hs |

**Idea concreta:** Hermes corre cada 15 min, lee logs de FAMA, detecta anomalías (circuit breaker abierto, errores 5xx repetidos, leads sin respuesta >2hs) y notifica a Mariano. Canal de notificación a definir.

---

## 4. Dónde NO usar cada herramienta

| Herramienta | NO usar para | Por qué |
|-------------|--------------|---------|
| **Hermes** | Refactor de 300+ líneas | Límite de turnos, se corta a la mitad |
| **Hermes** | Benchmark de modelos | No tiene el contexto del eval set ni del negocio |
| **Claude Code** | Deploys en producción sin supervisión | Requiere confirmación de Mariano |
| **Claude Code** | Decisiones de negocio (precios, estrategia) | Eso es de FOMO, no del código |

---

## 5. Estado actual del código

| Componente | Modelo | Estado |
|------------|--------|--------|
| Recepcionista | gpt-4o-mini | ✅ En producción |
| Backoffice | gpt-4o | ✅ En producción |
| Agendador | gpt-4o-mini | ✅ En producción |
| Transcripción audio | whisper-1 | ✅ En producción |
| Descripción imágenes | gpt-4o vision | ✅ En producción |

Todos los agentes usan OpenAI. Si se quiere migrar a Claude (Anthropic), Mastra soporta `anthropic/claude-*` — candidato para el benchmark de Fase 3.

---

## 6. Próximo paso

**Operacional (Mariano):** Seguir los 6 pasos de la Fase 2.5 para activar el web chat en fomologic.com.ar. No requiere más código, solo configuración en Chatwoot + embed script en el sitio.

**Código (Claude Code):** Fase 3 — benchmark de modelos (gpt-4o-mini vs claude-haiku-4-5 para recepcionista, gpt-4o vs claude-sonnet-4-6 para backoffice).
