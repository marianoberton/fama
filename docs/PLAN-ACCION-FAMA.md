# FAMA — Plan de Acción: Combo Hermes + Kimi + Claude Code

> Fecha: 2026-05-16
> Objetivo: Definir dónde brilla cada pieza del stack y cómo se complementan

---

## 1. El Combo: Quién hace qué

### 🧠 Kimi K2.6 (vía OpenRouter / kimi-coding)
**Rol:** Modelo principal de razonamiento y orquestación

| Tarea | Por qué Kimi |
|-------|--------------|
| **Evaluación de conversaciones** | Contexto largo (200k+ tokens), puede leer transcripts completos y evaluar calidad |
| **Generación de prompts** | Bueno en estructurar instrucciones complejas (como los prompts de FAMA) |
| **Análisis de métricas** | Puede procesar logs, detectar patrones, sugerir mejoras |
| **Documentación técnica** | Escribe specs claros (ya lo hicimos con decision-tree.yaml) |
| **Debugging de flujos** | Puede simular decision trees y encontrar gaps |

**Limitación:** No tiene acceso directo al VPS. Necesita Hermes como intermediario.

---

### 🤖 Hermes Agent (FAMA — yo)
**Rol:** Operador del VPS, ejecutor, integrador

| Tarea | Por qué Hermes |
|-------|----------------|
| **Fixes de código** | Acceso directo al filesystem del VPS, puede editar, testear, deployar |
| **Monitoreo en vivo** | Puede leer logs, ver estado de servicios, ejecutar comandos |
| **Integración de servicios** | Conecta Chatwoot, Twenty, GCal, Langfuse — todo desde el VPS |
| **Documentación visual** | Genera diagramas Excalidraw, reportes, specs |
| **Git ops** | Commits, push, PRs, deploys |

**Limitación:** Modelo limitado a ~90 turnos por conversación. Para tareas largas necesita delegar o usar cronjobs.

---

### 💻 Claude Code Opus 4.7 (CLI agent)
**Rol:** Coding agent autónomo para tareas complejas

| Tarea | Por qué Claude Code |
|-------|---------------------|
| **Refactor grande** | Puede trabajar 30+ minutos solo, editando múltiples archivos |
| **Implementar features nuevas** | Agarra un spec y lo implementa end-to-end |
| **Tests** | Escribe suites de tests completas |
| **Code review** | Analiza diff, detecta bugs, sugiere mejoras |
| **Migraciones** | Cambiar de framework, actualizar dependencias |

**Limitación:** Corre en el VPS pero necesita ser invocado. No tiene memoria persistente entre sesiones (a menos que usemos `.claude/`).

---

## 2. Flujo de trabajo ideal

```
┌─────────────────────────────────────────────────────────────┐
│  MARIANO (vos)                                               │
│  "Necesito X" / "Fix Y" / "Evaluá Z"                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  HERMES (yo) — Evaluador rápido                              │
│  • ¿Es un fix de 1 línea? → Lo hago yo                      │
│  • ¿Es un refactor mediano? → Delego a Claude Code          │
│  • ¿Es análisis estratégico? → Consulto a Kimi              │
│  • ¿Es monitoreo/ops? → Lo hago yo                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
   ┌─────────┐   ┌──────────┐   ┌──────────┐
   │  KIMI   │   │  HERMES  │   │ CLAUDE   │
   │(análisis│   │(fixes     │   │ CODE     │
   │ prompts,│   │ rápidos,  │   │(refactor │
   │ métricas│   │ deploys,  │   │ grande,  │
   │ docs)   │   │ monitoreo)│   │ features)│
   └────┬────┘   └────┬─────┘   └────┬─────┘
        │             │              │
        └─────────────┴──────────────┘
                      │
                      ▼
        ┌─────────────────────────┐
        │   HERMES integra todo   │
        │   • Aplica cambios      │
        │   • Corre tests         │
        │   • Deploya             │
        │   • Reporta a Mariano   │
        └─────────────────────────┘
```

---

## 3. Plan de acción concreto

### Fase 1: Fixes urgentes (esta semana)
**Quién:** Hermes (yo) + Claude Code para lo pesado

| # | Tarea | Quién | Tiempo |
|---|-------|-------|--------|
| 1 | Fix `logger` en chatwoot.ts | Hermes | 5 min |
| 2 | Resolver zod v3 vs v4 | Claude Code | 30 min |
| 3 | Pinear versiones en package.json | Hermes | 10 min |
| 4 | Agregar /health endpoint | Hermes | 15 min |
| 5 | Correr tests y verificar | Hermes | 20 min |

**Comando para Claude Code:**
```bash
claude -p "Fix the zod peer dependency conflict in this Mastra project. 
The project uses zod@4 but @mastra/core brings @ai-sdk/provider-utils 
which requires zod@^3.23.8. Make tests run again. 
Project is at /home/ubuntu/fama"
```

---

### Fase 2: Refactor y métricas (este mes)
**Quién:** Claude Code para refactor + Hermes para integración

| # | Tarea | Quién | Tiempo |
|---|-------|-------|--------|
| 6 | Refactorizar webhook handler (692 líneas → módulos) | Claude Code | 2-3 hs |
| 7 | Agregar métricas básicas (leads/día, conversion, tiempo) | Claude Code | 2 hs |
| 8 | Dashboard simple (HTML/JSON) | Hermes | 1 h |
| 9 | Feedback loop humano → mejora de prompts | Kimi + Hermes | 2 hs |

**Comando para Claude Code:**
```bash
claude -p "Refactor the webhook handler in /home/ubuntu/fama/src/server/webhook.ts 
(692 lines) into smaller modules. Keep all existing behavior. 
Extract: dedup logic, circuit breaker handling, welcome logic, 
LLM invocation, attachment processing, and response formatting 
into separate files under src/server/handlers/. 
Write tests for each extracted module."
```

---

### Fase 3: Evaluación de modelos (próximas 2 semanas)
**Quién:** Kimi para análisis + Hermes para ejecutar benchmarks

| # | Tarea | Quién | Tiempo |
|---|-------|-------|--------|
| 10 | Benchmark: gpt-4o-mini vs Kimi K2.5 vs Kimi K2.6 | Hermes | 4 hs |
| 11 | Benchmark: gpt-4o vs Kimi K2.6 (backoffice) | Hermes | 2 hs |
| 12 | Análisis de costo/performance | Kimi | 30 min |
| 13 | Decisión de modelo por agente | Kimi + Mariano | 30 min |

**Benchmark:** Correr el mismo set de 20 conversaciones de test con cada modelo, medir:
- Calidad de respuesta (evaluado por Kimi)
- Tiempo de respuesta
- Costo por conversación
- Tasa de handoff correcto

---

### Fase 4: Integración Hermes como supervisor (próximo mes)
**Quién:** Hermes + Claude Code

| # | Tarea | Quién | Tiempo |
|---|-------|-------|--------|
| 14 | Hermes como "observador" de FAMA | Hermes | 4 hs |
| 15 | Alertas proactivas (circuit breaker, errores) | Hermes | 2 hs |
| 16 | Reporte diario de métricas | Hermes (cronjob) | 1 h |
| 17 | Intervención humana sugerida | Hermes | 2 hs |

**Idea:** Hermes corre un cronjob cada 15 min que:
1. Lee logs de FAMA
2. Detecta anomalías (errores, circuit breaker abierto, leads sin respuesta)
3. Envía alerta a Mariano por Telegram
4. Sugiere acción ("El circuit breaker está abierto desde hace 10 min, ¿querés que revise?")

---

## 4. Dónde NO usar cada herramienta

| Herramienta | NO usar para | Por qué |
|-------------|--------------|---------|
| **Kimi** | Editar código en el VPS | No tiene acceso al filesystem |
| **Kimi** | Monitoreo en tiempo real | No puede leer logs en vivo |
| **Hermes** | Refactor de 500+ líneas | Límite de 90 turnos, se corta |
| **Hermes** | Análisis profundo de métricas | Contexto limitado para análisis estadístico |
| **Claude Code** | Decisiones de negocio | No tiene contexto de FOMO, precios, estrategia |
| **Claude Code** | Deploys en producción | Necesita supervisión humana |

---

## 5. Sobre "Opus 4.7"

Buscando en el código, no encontré referencias a Claude Opus 4.7 como modelo de FAMA. Lo que sí hay:

- **gpt-4o-mini** → Recepcionista y Agendador
- **gpt-4o** → Backoffice
- **whisper-1** → Transcripción de audio (opus/ogg)
- **gpt-4o vision** → Descripción de imágenes

**Claude Code 2.1.126** está instalado en el VPS (`/home/ubuntu/.local/bin/claude`). Es la herramienta CLI, no un modelo.

**Si querés probar Claude Opus como modelo para los agentes de FAMA:**
- Mastra soporta `anthropic/claude-opus-4` vía OpenRouter
- Podríamos hacer un benchmark comparando gpt-4o vs Claude Opus para el backoffice
- Costo: Opus es ~3x más caro que gpt-4o

---

## 6. Próximo paso inmediato

¿Arrancamos con la Fase 1? Puedo:

1. **Fixear el `logger`** ahora mismo (5 min)
2. **Lanzar Claude Code** para el zod + tests (30 min)
3. **Pinear versiones** (10 min)
4. **Agregar /health** (15 min)

Total: ~1 hora para tener FAMA estable y testeable.

¿Hacemos?