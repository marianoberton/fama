# SCOPE — FAMA v4 (Production grade)

**Fecha**: 2026-05-12
**Owner**: Mariano Berton
**Estado**: Borrador para revisión.
**Estimación total**: 4-7 días según se incluya o no el Sprint 4 opcional.

---

## ¿Qué motiva v4?

Hoy FAMA está en producción pero todavía requiere atención manual de Mariano:
- Cada bug requiere leer logs crudos y adivinar qué hizo el LLM.
- Si OpenAI tiene un blip, FAMA devuelve 500 y deja al cliente sin respuesta.
- Cada cambio de prompt es ruleta — no hay forma de validar que no se rompió otro caso.
- No hay forma de silenciar FAMA en una conversación específica sin esperar al auto-handback.

**Outcome de v4**: FAMA puede correr 30+ días sin intervención de Mariano. Cuando aparece un bug, se diagnostica en minutos (no horas) mirando traces. Cuando OpenAI o Chatwoot tienen un incidente, FAMA degrada gracefully. Cada PR corre una eval set automática que detecta regresiones.

Esto es el bloque que habilita el **BLUEPRINT** (sesión Fase 1+2 documentada en PLAN-FAMA-MASTER.md Bloque 6): para extraer patrones reutilizables, FAMA tiene que estar **estable** primero. v4 entrega esa estabilidad.

---

## Sprints

### Sprint 1 — Observabilidad con Langfuse (1-2 días)

**Outcome**: cada conversación deja un trace completo con todos los LLM calls, tool calls, delegaciones entre agentes, latencia y costo.

**Decisión clave**: **Langfuse self-hosted** en el VPS. Mariano levanta el contenedor con docker-compose oficial de Langfuse. Trade-off aceptado: 1 contenedor más en el VPS a cambio de evitar costo de Cloud + datos quedan in-house.

**Lo que se trackea**:
- Cada `recepcionista.generate()` y sub-agente (backoffice, agendador) como un trace anidado.
- Cada tool call con su input + output (knowledge-search, chatwoot-handoff, upsert-twenty-lead, list-calendar-slots, book-calendar-event).
- Latencia y costo por turn.
- Thread id de Mastra como sessionId de Langfuse para agrupar conversaciones.

**Decisión a tomar antes**:
- ¿Redactar PII en traces? El payload de WhatsApp tiene phone, email, nombre real del cliente. Por default no se redacta — los traces son privados a FOMO. Si en v5 entra otro cliente, se revisa.

**Cambios de código** (estimados):
- `src/lib/observability.ts` nuevo — wrapper de Langfuse SDK.
- Hook en `src/server/webhook.ts` y agentes para crear/cerrar trace.
- Mastra ya expone `onDelegationStart/Complete` y telemetry hooks — usar esos en lugar de instrumentar manual.
- Env: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`.

**Pendientes Mariano**:
- Crear cuenta en `cloud.langfuse.com` y un proyecto "FAMA".
- Pegar keys en `.env` + Dockploy.

---

### Sprint 2 — Resiliencia (1 día)

**Outcome**: FAMA degrada gracefully ante fallos de OpenAI / Chatwoot en lugar de devolver 500.

**Sub-feature 1: Fallback OpenAI down**
- Si `recepcionista.generate()` falla N veces consecutivas dentro de M minutos → abrir circuit.
- Cuando circuit está abierto: el webhook responde inmediato con un mensaje fijo al cliente ("Disculpá, estoy con un problema técnico — te paso con el equipo en breve") + dispara `chatwoot-handoff` con category `escalar-humano`.
- Después de 5 min de circuit abierto → half-open: el próximo turn prueba. Si OK → close. Si falla → re-open por otros 5 min.

**Defaults**:
- N=3 fallos consecutivos
- M=60 segundos
- Recovery=5 minutos

**Sub-feature 2: Graceful shutdown de workers**
- NURTURING worker, auto-handback worker y dedup cleanup deben drenar pending operations antes de exit.
- Hook `SIGTERM` → `stop()` de cada worker + `await` de cualquier tick en curso.
- Importante para deploys: si Dockploy mata el container en medio de un retry de NURTURING, el row queda en estado raro.

**Sub-feature 3: Circuit breaker en Chatwoot API**
- Si `chatwoot-handoff` o `sendChatwootMessage` falla 3× seguidas con 5xx → circuit open por 2 min.
- Mientras está abierto: logs ERROR + el flow continúa sin postear (mensaje al cliente se loggea pero no se manda).
- Razón: si Chatwoot está caído y FAMA insiste, los logs explotan. Mejor pausar y reintentar después.

**Cambios de código**:
- `src/lib/circuit-breaker.ts` nuevo — clase genérica reutilizable.
- Wrapper en `src/lib/chatwoot.ts` y `src/lib/openai-multimodal.ts`.
- Hook en `src/server/webhook.ts` para invocar el fallback cuando el LLM circuit está abierto.
- Hook `SIGTERM` en `src/mastra/index.ts`.

---

### Sprint 3 — Eval set sistemático (2 días)

**Outcome**: cada PR corre 20-30 conversaciones canónicas contra el LLM real y valida que no se rompió ningún arquetipo / excepción.

**Sub-feature 1: Conversaciones canónicas**
Archivo YAML por caso con:
```yaml
case: "arquetipo-caliente-1"
description: "Empresa industrial, 80 empleados, caso concreto, urgencia"
turns:
  - role: customer
    content: "Hola, soy dueño de una fábrica de 80 empleados..."
  - role: customer
    content: "Necesitamos automatizar el área de cobranzas, queremos arrancar este mes"
expect:
  - tool_call: upsert-twenty-lead
    args_contain:
      stage: MEETING
      arquetipo: caliente
  - tool_call: chatwoot-handoff  # OR delegate to agendador
    or:
      delegated_to: agendador
  - final_response_matches: "te paso con (Mariano|el equipo|un asesor)"
```

Casos a crear:
- **4 arquetipos** × 2 variations = 8 casos
- **5 excepciones** × 2 variations = 10 casos
- **Edge cases**: cliente conocido, mensaje muy largo, mensaje corto, audio, imagen, off-topic, agresivo, cambio de tema = 8 casos
- **Total**: ~26 casos

**Sub-feature 2: Runner**
- Script `npm run eval` que:
  1. Lee todos los `.yaml` de `tests/eval/cases/`.
  2. Para cada caso, ejecuta los turns secuencialmente con un `Mastra` real (no mockeado).
  3. Inspecciona `reply.steps[*].toolCalls` y el `reply.text` final.
  4. Valida contra los `expect`.
  5. Sube el trace a Langfuse con tag `eval`.
- Output: tabla por caso con pass/fail + link al trace de Langfuse.
- Cost estimado: USD 0.20-0.50 por full run (gpt-4o-mini + gpt-4o backoffice).

**Sub-feature 3: Aserciones LLM-as-judge**
- Para aserciones de wording (no estructura), usar gpt-4o-mini como juez con prompt fijo:
  > "Dado este final_response del agente: '...' y esta expectativa: '...', ¿el response cumple la expectativa? Responde solo 'sí' o 'no' + 1 línea de razón."
- Costo: ~USD 0.001 por aserción de wording.

**Sub-feature 4: Integración CI**
- GitHub Action que corre `npm run eval` en cada PR a `main`.
- Si pasa: ✅ comment con resumen.
- Si falla: 🔴 block merge + link al trace fallado en Langfuse.
- Decisión: ¿bloquea merge o solo advierte? Recomendado: bloquea para `main`, advierte para feature branches.

**Cambios de código**:
- `tests/eval/cases/*.yaml` (26 archivos).
- `tests/eval/runner.ts` — script ejecutable con `tsx`.
- `tests/eval/judge.ts` — wrapper LLM-as-judge.
- `.github/workflows/eval.yml` — GitHub Action.

**Pendientes Mariano**:
- Revisar los 26 casos canónicos antes de codear (cuáles son los wordings esperados, cuáles son los hard requirements vs soft).
- Decidir si el CI bloquea merge o solo advierte.

---

### Sprint 4 (opcional) — Operational controls (1-2 días)

**Outcome**: control fino sobre comportamiento por conversación + hardening del payload entrante.

**Prioridad alta dentro del sprint**:

**Label `no-bot`**: si una conversación tiene aplicada esta label (manual desde Chatwoot UI), FAMA no procesa sus webhooks. Aplica a casos especiales — lead VIP, conversación legal, escalación que Mariano quiere manejar personalmente sin que el bot vuelva al auto-handback.
- Cambio: regla 8 del filter (`src/server/filter.ts`) que chequea `body.conversation.labels` contra `no-bot`.
- Aplica DESPUÉS de la regla 3 (status pending) — primero filtramos por status, después por label.

**Validación Zod del payload Chatwoot**:
- Hoy `extractMessage` hace casting manual con `isObject` + `typeof`. Funciona pero es frágil — un payload con shape inesperado puede causar TypeError downstream.
- Reemplazar con Zod schema de Chatwoot v4.12.1.
- Si el payload no matchea: 200 silencioso con `reason: 'payload_shape_invalid'` + logger.warn con el payload (truncado) para debug.

**Prioridad media**:

**Debouncing de mensajes seguidos del mismo cliente**:
- Si un cliente manda 3 mensajes en 5 segundos, el bot los procesa por separado y responde 3 veces.
- Fix: ventana de 3s — el primer mensaje espera 3s antes de invocar el LLM. Si llegan más durante esos 3s, se concatena el contenido y se procesa una sola vez.
- Tradeoff: agrega latencia de 3s al primer reply.

**Prioridad baja**:

**Inferencia de timezone**:
- Hoy NURTURING asume todos los clientes en horario AR (UTC-3).
- Si en v5 entra un cliente de Chile o Brasil, el reintento sale fuera de su horario.
- Fix: detectar timezone del primer mensaje del cliente vía LLM ("¿en qué país está?" implícitamente) y guardar en Twenty.
- Complejidad: alta. Se posterga a v5 si v4 se sale del scope.

**Cambios de código** (solo lo prioritario):
- `src/server/filter.ts` — regla 8 con label no-bot.
- `src/lib/chatwoot-payload.ts` nuevo — Zod schemas.
- `src/server/webhook.ts` — usar el Zod parsing.
- `src/lib/debouncer.ts` nuevo (si se incluye).

---

## Criterios de éxito de v4

- [ ] Cada conversación tiene trace completo en Langfuse (visible desde la UI).
- [ ] OpenAI simulado caído (test manual) → FAMA postea fallback + escalada, no 500 al cliente.
- [ ] `npm run eval` pasa los 26 casos canónicos con LLM real.
- [ ] CI bloquea PR si la eval falla (configurable).
- [ ] FAMA puede correr 30 días sin intervención (zero alertas vía Langfuse). Validable: dejar correr 30 días y revisar.
- [ ] Label `no-bot` aplicada → bot silencia conversación incluso después de auto-handback tick.

---

## Lo que NO va en v4 (queda para v5+ o BLUEPRINT)

- **Templates de Meta para NURTURING >24hs** — requiere alta de Meta Business + plantillas aprobadas (típicamente 2-4 semanas). Mejor en v5 cuando haya volumen real de leads perdidos por la ventana de 24hs.
- **Dashboard custom de KPIs** — Langfuse cubre lo básico (mensajes/día, latencia, costo, tool usage). Si Mariano necesita métricas específicas (tasa de captura, tasa de escalación correcta), se construye con queries de Langfuse, no UI custom.
- **Multi-tenant** — sigue siendo v∞.
- **Auto-handback sofisticado** (humano demorado, no solo inactividad) — el simple de v3 alcanza.
- **Conversation memory pruning** — cuando `mastra.db` pase los X MB (no es hoy).
- **Cost optimization** (prompt caching, embeddings cache) — solo si v4 expone costos altos via Langfuse.
- **BLUEPRINT** — es POST-v4, no parte de v4.
- **Inferencia de timezone** (solo si Sprint 4 lo skipea).

---

## Decisiones tomadas (2026-05-12)

1. **Sprints 1, 2 y 3 entran en v4**. Sprint 4 se difiere.
2. **Langfuse self-hosted** en el VPS (no Cloud). Mariano levanta el contenedor.
3. **CI**: bloquea para `main`, advierte para feature branches.
4. **PII en traces**: no se redacta (traces privados a FOMO).
5. **Hard vs soft de casos canónicos**: a definir durante Sprint 3 con review de cada caso.

---

## Orden recomendado

```
Día 1-2:  Sprint 1 — Langfuse (observabilidad)
Día 3:    Sprint 2 — Resiliencia (fallback + circuit breaker + graceful shutdown)
Día 4-5:  Sprint 3 — Eval set (casos canónicos + runner + CI)
Día 6-7:  Sprint 4 (opcional) — Label no-bot + Zod (si urgente)

Validación final: dejar FAMA corriendo 1 semana, revisar Langfuse, ajustar prompts si los traces muestran patrones malos.
```

---

## Después de v4 — el camino a BLUEPRINT

Una vez v4 está ✅ y los criterios de éxito del PLAN-FAMA-MASTER.md Bloque 5.3 están todos verdes:

1. **Sesión Fase 1 del blueprint** (2-3hs): extraer patrones reutilizables a `BLUEPRINT.md`.
2. **Sesión Fase 2 del blueprint** (2-3hs): convertir BLUEPRINT.md en repo template.
3. **Decidir agente #2**: Mateo (cobranzas), Lucas (ventas), o el que pida primero algún cliente.
4. **Construir agente #2 con el template**: meta 3-5 días vs los ~30-40 horas que tomó FAMA.

v4 es el último bloque de trabajo sobre FAMA "pura". Lo que viene después es **horizontal** (otros agentes), no **vertical** (más features para FAMA).
