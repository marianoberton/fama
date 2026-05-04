# CLAUDE.md — Memoria del proyecto FAMA

Este documento define las decisiones, restricciones y patrones específicos del proyecto FAMA. Es complemento al skill de Mastra (que cubre el framework) — acá vive lo específico de este proyecto.

**Siempre leé este archivo al inicio de cada sesión.** Las decisiones de acá ya fueron tomadas y discutidas. No las re-cuestiones a menos que aparezca una razón nueva.

---

## Qué es este proyecto

FAMA es el agente de atención al cliente de **FOMO** (consultora argentina de IA en LATAM, fundada por Mariano Berton y Guillermina Berton). Recibe mensajes de WhatsApp via Chatwoot y atiende a quien escribe a `+5491172343506`.

Este proyecto **reemplaza** un sistema anterior llamado `fomo-core` que tenía deuda técnica acumulada (knowledge contradictoria, tools nombradas que no existían, secrets faltantes). Estamos partiendo limpio con disciplina.

## Sobre FOMO (el negocio que FAMA representa)

- **Sitio**: fomologic.com.ar
- **Email**: hola@fomologic.com
- **Fundadores**: Mariano Berton (CTO), Guillermina Berton (Head of Operations)

**Tres frentes de servicio** — solo estos, ningún otro:
1. Empleados de IA
2. Consultoría en IA
3. Capacitaciones en IA

**Seis empleados de IA** — solo estos, ningún otro:
- Elena (atención al cliente)
- Mateo (cobranzas)
- Lucas (ventas)
- Franco (análisis de competencia)
- Mia (asistente personal)
- Nadia (licitaciones)

Más un Manager que coordina al equipo (incluido a partir del plan Equipo).

**Si encontrás referencias a otros empleados o servicios en cualquier código, knowledge o prompt — es deuda técnica heredada del sistema viejo. Eliminala.**

## Arquitectura del proyecto

**Multi-agente: Recepcionista (supervisor) + Backoffice (subagente).**

```
WhatsApp → Chatwoot → webhook → [filtro 6 reglas]
                                       │
                                       ├─ primer turno + <30 palabras → texto fijo de bienvenida (sin LLM)
                                       │
                                       └─ Recepcionista (FAMA, supervisor)
                                              │
                                              ├─ knowledge-search (info de FOMO)
                                              │
                                              └─ delega al subagente Backoffice
                                                     (vía patrón nativo de Mastra: `agents: { backoffice }` + Memory)
                                                     │
                                                     ├─ knowledge-search
                                                     ├─ chatwoot-handoff (escalar a humano)
                                                     └─ upsert-twenty-lead (CRM, mock en v1)

NURTURING worker (proceso aparte, setInterval 15min)
   ├─ lee `nurturing_conversations` (LibSQL, misma DB que Memory)
   ├─ retry 1 a las ~4hs sin respuesta del cliente
   ├─ retry 2 a las ~22hs (antes de cerrar ventana 24h Meta)
   ├─ filtra por horario AR (9-19 UTC-3) y status Chatwoot (skip si `open`)
   └─ marca lead LOST tras 2 reintentos sin respuesta
```

- **Recepcionista (FAMA, supervisor)**: conversa, hace discovery, identifica intención. Cuando hay venta clara, delega al backoffice usando el patrón nativo de Mastra — no una tool custom.
- **Backoffice (subagente)**: especialista de ventas. Aplica árbol de decisión (4 arquetipos + 5 excepciones), guarda lead en CRM, decide si escalar al humano. Spec completo en `fama-design-v1.md §5`.
- **NURTURING worker**: arranca con el server (excepto en `NODE_ENV=test`), corre cada 15 min, mantiene tabla propia de conversaciones para decidir reintentos. Spec completo en `fama-design-v1.md §7`.

## Stack y restricciones

- **Framework**: Mastra (usar el skill instalado para todas las APIs).
- **Lenguaje**: TypeScript con ES2022 (requirement de Mastra).
- **Modelo**: `openai/gpt-4o-mini` para el recepcionista, `openai/gpt-4o` para el backoffice en v1. Configurar via Mastra model router (`provider/model-name`).
- **Provider único en v1**: solo OpenAI. No usar Anthropic, Google, etc.
- **Server**: Express o lo que el skill de Mastra recomiende para webhook handlers.
- **Deploy target**: VPS propio con Docker (red `fomo-net` ya existe en el VPS donde corre Chatwoot).
- **NO usar en v1**: Slack (deuda técnica del sistema viejo), Twenty real (mock), Telegram real (mock), Anthropic SDK directo, conexión a fomo-core viejo.

## Configuración de Chatwoot (datos reales)

```
CHATWOOT_BASE_URL=https://chat.fomo.com.ar
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=3
CHATWOOT_AGENT_BOT_ID=2
CHATWOOT_PATH_TOKEN=<CONFIGURAR_EN_ENV>   # valor real vive en .env local (no commitear)
CHATWOOT_TEAM_ID=1
```

El `CHATWOOT_API_TOKEN` está en `.env` (no hardcodearlo en código nunca).

**Labels válidas en Chatwoot** (ya creadas, son las únicas válidas):

```typescript
export const CHATWOOT_VALID_LABELS = [
  'escalar-humano',       // cliente pide hablar con persona
  'venta-capacitacion',   // interés en cursos/workshops
  'venta-agentes',        // interés en empleados de IA
  'venta-consultoria',    // interés en consultoría estratégica
  'reclamo',              // queja o problema
  'urgencia',             // enojo / plazo crítico / legal
] as const;
```

Si una tool intenta aplicar una label fuera de esa lista, debe fallar con ValidationError antes de llamar a Chatwoot.

## Filtrado obligatorio del webhook

El webhook handler en `/v1/webhooks/chatwoot/:token` **debe filtrar al inicio** y devolver `200 OK` silencioso para todo lo que no corresponda procesar. Sin este filtro, FAMA recibe `conversation_resolved`, `conversation_updated`, etc., y gasta tokens generando respuestas inválidas.

> **Nota**: el path NO arranca con `/api/` porque Mastra reserva `/api/*` para sus rutas internas (agents, workflows, openapi). Ver bitácora 2026-05-02.

Reglas de filtrado en orden:

1. Path token inválido → `401`.
2. `body.account.id !== CHATWOOT_ACCOUNT_ID` → `401`.
3. `body.conversation?.status !== 'pending'` → `200` silencioso (`conversation_not_pending`). Una vez que un humano toma la conversación, Chatwoot flipea el status de `pending` a `open`; el bot debe callar para no hablar encima del humano. Aplica también a `resolved` (cerrada) y `snoozed` (pausada).
4. `body.event !== 'message_created'` → `200` silencioso.
5. `body.conversation?.messages?.[0]?.message_type !== 0` (donde 0 = incoming; fallback a `body.messages?.[0]` por compatibilidad con shapes viejos) → `200`.
6. `body.conversation?.messages?.[0]?.sender?.type !== 'contact'` → `200`.
7. Contenido vacío o solo whitespace → `200`.

Recién después de esto, invocar al agente.

**Handback humano→bot**: cuando un humano termina de atender y quiere que el bot retome la conversación, cambia el status de `open` a `pending` desde el dropdown del header en la UI de Chatwoot. El próximo mensaje entrante pasa la regla 3 (status pending) y FAMA lo procesa. No existe un botón "send to bot" dedicado — el flip de status manual ES el mecanismo (validado contra docs oficiales de Chatwoot y código de Captain). Para auto-handback por inactividad va a hacer falta un worker dedicado en v2: las automation rules de Chatwoot v4.12.1 no exponen "set status to pending" como acción ni tienen evento de inactividad.

## Patrones de la tool `chatwoot-handoff`

Esta es la tool central del sistema. Ejecuta **5 llamadas a la API de Chatwoot en orden** (paso 0 = ack público, después los 4 canónicos), y maneja errores correctamente.

**Input**: `{ conversationId, category, ackMessage, reason }`. La tool postea el `ackMessage` por su cuenta (paso 0) — el agente NO debe escribir un mensaje al usuario después de la tool, va a duplicar.

**Orden de llamadas:**

0. `POST .../messages` con `{ content: ackMessage, message_type: 'outgoing', private: false }` (mensaje público al cliente, ANTES del toggle_status — requirement de CLAUDE.md "ack inmediato")
1. `POST .../labels` con `{ labels: [category] }`
2. `POST .../messages` con `{ content: reason, private: true, message_type: 'outgoing' }` (nota privada con el contexto formateado)
3. `POST .../assignments` con `{ team_id: CHATWOOT_TEAM_ID }`
4. `POST .../toggle_status` con `{ status: 'open' }`

**Por qué en este orden**: el `toggle_status` va al final para que cuando la automation rule de Chatwoot detecte `status=open` con team asignado, ya tenga toda la metadata (label, nota, team) cargada. El paso 0 (ack) precede a todo para que el cliente vea el mensaje "te paso con un asesor" antes de que la conversación flipée a humano (requirement de CLAUDE.md).

**Coordinación con el webhook handler**: la tool retorna `{ replyHandled: true }` cuando posteó el ack. El webhook handler inspecciona los `toolResults` (incluyendo `subAgentToolResults` por delegación del supervisor) y, si encuentra `replyHandled === true`, **NO postea** el texto final del agente — así evitamos enviar dos mensajes al cliente.

**Reglas de error**:
- Sin retry automático en v1.
- Si cualquier paso falla, devolver `{ success: false, step_failed: 0|1|2|3|4, error, replyHandled }` (replyHandled = true si el paso 0 ya pasó, así el webhook no duplica el ack).
- Loguear con nivel ERROR (no info, no warn) en cada fallo.
- Lock se libera al fallo, así un re-intento (manual o vía re-invocación del agente) puede correr.

**Idempotencia**: lock interno en memoria por `conversationId`. Si la misma conversación fue handoffeada en los últimos 60 segundos, retornar no-op exitoso `{ success: true, step_failed: null, replyHandled: true, idempotentSkip: true }`.

**Template obligatorio de la nota privada** (parámetro `reason`):

```
Categoría: <category>
Motivo: <razón en 1-3 oraciones>
Cliente: <nombre si lo dijo, sino "no identificado">
Empresa: <si aplica, sino "no mencionada">
Datos clave: <ej: cantidad, presupuesto, plazo>
```

El backoffice es responsable de armar este string con el contexto recolectado.

## Tools del proyecto

| Tool | Estado v1 | Quién la usa |
|---|---|---|
| `knowledge-search` | Real | Recepcionista + Backoffice |
| `chatwoot-handoff` | Real | Solo Backoffice |
| `upsert-twenty-lead` | Mock con contrato real (incluye `stage` enum NEW/CONTACTED/MEETING/PROPOSAL/WON/LOST) | Solo Backoffice + worker NURTURING |

> Nota: la "delegación al backoffice" NO es una tool — usa el patrón nativo `agents: { backoffice }` + `Memory` de Mastra. Ver bitácora 2026-05-02.

**No agregues tools sin discutirlo primero.** Si pensás que falta una, decímelo, lo evaluamos juntos. Patrón aprendido del sistema viejo: las tools acumuladas sin curaduría generaron deuda técnica grande.

## Knowledge base

La knowledge vive en `src/knowledge/` como archivos markdown. **No la repliques desde fomo-core viejo** — tiene contradicciones (empleados que no existen, precios obsoletos, instrucciones legacy). Solo migrá contenido validado.

Archivos a crear (contenido validado):
- `identity.md` — qué es FOMO, fundadores, diferencial
- `employees.md` — los 6 empleados + Manager
- `pricing.md` — Starter, Equipo, Completo, Enterprise
- `services.md` — los 3 frentes de servicio
- `faqs.md` — FAQs vigentes (tiempos, contratos, canales, etc.)
- `sales.md` — propuesta de valor

Si encontrás contenido en `fomo-core` que mencione "Sofía", "Marcos", "Valentina", "Diego" o precios distintos a los del archivo `pricing.md` — eso es legacy, **NO lo migres**.

## Decisiones que ya están tomadas (no las re-cuestiones)

- **Multi-agente** (Recepcionista supervisor + Backoffice subagente) vía el patrón nativo de Mastra (`agents: { backoffice }` + `Memory`), no tool custom de delegación. Decisión de proyecto: defaultear a primitivos del framework, sólo escribir custom cuando sea necesario.
- **gpt-4o-mini** para el recepcionista y **gpt-4o** para el backoffice en v1.
- **Sin retry automático** en handoff. Falla → log ERROR → reintentos vienen del flujo natural del agente.
- **Lock interno de 60s** para idempotencia (no chequeo contra Chatwoot).
- **Mock de Twenty** en v1 (lead registration), integración real en v2.
- **Sin Slack ni Telegram** en v1. La tool `notify-mariano` quedó eliminada — si en v2 querés notificación a Mariano se reimplementa contra el canal definitivo (no asumimos Telegram).
- **NURTURING (worker de seguimiento) entra en v1.** Reintentos a ~4h y ~22h sin respuesta del cliente, sólo dentro de la ventana de 24h de Meta y en horario laboral AR (9-19hs UTC-3). Cancela si la conversación está escalada (`open`), si el lead es `WON`/`LOST`, o tras 2 reintentos. Spec completo en `fama-design-v1.md §7`.
- **Primer turno hard-coded**: si el primer mensaje del cliente tiene <30 palabras y todavía no le respondimos nada en esa conversación, el handler postea un texto fijo de bienvenida sin invocar al LLM. Si tiene ≥30 palabras o ya hubo respuesta previa del bot, sigue por el flujo normal (recepcionista → backoffice). Spec en `fama-design-v1.md §4`.
- **Bar mínimo del Backoffice = 4 datos** (Nivel 2 del diseño): empresa, caso de uso/problema, tamaño aproximado, indicio de timeline. Excepciones rígidas (pedido humano / urgencia / reclamo) bajan el bar a "nombre + canal de contacto" — el árbol del backoffice las evalúa primero. Spec en `fama-design-v1.md §5`.
- **Mensaje de acknowledge inmediato** cuando el backoffice escala. Implementado como paso 0 de `chatwoot-handoff` (la tool recibe `ackMessage` por parámetro y lo postea como mensaje público antes de la secuencia 1-4). El webhook handler skipea el post del texto final del agente cuando detecta `replyHandled: true` para no duplicar.
- **Calendly link**: vendrá un Cal.com personal de Mariano. Por ahora dejar como variable `CALENDLY_LINK` en config, vacío por defecto. Cuando esté el link real, se conecta. **No hardcodear ningún link** en prompts ni código.

## Lo que NO va en v1

No construyas estas cosas, son v2 explícitamente:

- Templates de Meta WhatsApp Business para reintentos del NURTURING fuera de la ventana de 24h.
- Inferencia de timezone del cliente desde su primer mensaje (para horarios de envío apropiados — en v1 todo se asume horario AR).
- Debouncing / batching de mensajes seguidos.
- Conexión real a Twenty CRM (sigue como mock).
- Notificación a Mariano por canal externo (Telegram / Slack / mail) — la tool `notify-mariano` quedó eliminada en v1.
- Métricas en `fomo-platform`.
- Pre-flight validation de tools.
- ToolPacks como abstracción.
- Conversaciones protegidas con label `no-bot`.
- Handoff inverso sofisticado (reaperturas con heurística de tiempo).
- NURTURING que reintenta cuando el humano asignado se demoró (el worker básico SÍ está en v1; esta es la versión sofisticada).
- QUALIFIER como tercer agente separado del backoffice.
- PRICING_AGENT como agente separado.
- Multi-tenant (este proyecto es solo para FOMO; otros clientes son repos separados).

Si tenés ganas de agregar algo de la lista anterior porque "sería rápido" o "ya que estamos" — **resistilo**. Cada feature de v2 tiene razones por las que no está en v1.

## Reglas de código

- **Sin abstracciones que no usemos hoy.** No premature optimization, no genérics complejos, no patterns que parecen inteligentes.
- **Cada archivo entendible por sí solo.** Si necesitás contexto de 3 archivos para entender uno, refactorizá.
- **Comentarios solo donde el código no es obvio.** No comentes lo que ya dice el nombre de la función.
- **Mensajes de error claros.** Cuando algo falla, el log dice qué pasó y dónde, no solo "error".
- **Sin `console.log` en código final.** Logger simple (pino o similar) con niveles. Mocks pueden usar console.log temporalmente, pero marcalo con `// MOCK:` para que sea fácil grep.
- **Nada de hardcoding de credenciales o tokens.** Todo via env vars y `.env`.
- **Tests para lo crítico**, no para todo. Webhook filter, chatwoot-handoff, orquestación end-to-end. No tests de getters.

## Cuándo consultarme antes de avanzar

Si te encontrás en alguna de estas situaciones, frená y preguntá antes de generar código:

- El skill de Mastra dice una cosa y este CLAUDE.md dice otra cosa contradictoria.
- Tenés que tomar una decisión de arquitectura no cubierta acá.
- Una tool requiere capacidad nueva que no está en la lista.
- El usuario te pide algo que está en la sección "lo que NO va en v1".
- Encontrás algo en `fomo-core` que no estás seguro si copiar o no.
- La doc de Mastra (skill o remote) está ambigua sobre cómo modelar algo.
- Querés agregar una dependencia npm nueva.

En todos esos casos: **explicá la situación, presentá opciones, esperá decisión.**

## Plan de construcción sugerido

7 días aproximados, ajustar según realidad:

- **Día 1**: scaffolding (`npm create mastra@latest` o lo que el skill recomiende), config, webhook handler con filtrado completo, mocks de tools, tests del filtro.
- **Día 2**: agentes recepcionista y backoffice con prompts, tool `delegate-to-backoffice`, tests de orquestación.
- **Día 3**: tool `chatwoot-handoff` real, lock de idempotencia, tests de la tool.
- **Día 4**: knowledge-search funcionando con los markdown files, tests integrados con knowledge.
- **Día 5**: Dockerfile + docker-compose, build local, smoke test contra Chatwoot real (sin migrar tráfico todavía).
- **Día 6-7**: hardening, ajustes de prompts, documentación, validación con webhooks reales en staging, migración de tráfico.

**Cada día termina con commit limpio.** No mezcles features en un solo commit.

## Cómo testeamos

Dos niveles, complementarios:

1. **Tests automatizados** (`npm test`): cubren webhook filter, chatwoot-handoff, orquestación. Mocks para modelos OpenAI.

2. **Mastra Studio** (`npm run dev` → http://localhost:4111): para que Guille (socia, tester principal) pueda interactuar con los agentes manualmente y mandar mensajes raros. Esto es la prueba real de calidad conversacional.

Ambos niveles son obligatorios antes de declarar v1 terminada.

## Migración a producción (al final del v1)

**No apuntás Chatwoot al deploy nuevo hasta que el endpoint esté validado.**

Pasos:
1. Deploy de FAMA al VPS.
2. Healthcheck OK en `GET /health`.
3. Smoke test: enviar 5-10 webhooks simulados (curl con payloads reales) y verificar que respuestas sean correctas. Logs deben estar limpios.
4. Sentarse con Guille a probar ~20 conversaciones en Mastra Studio.
5. Recién entonces, en Chatwoot via Rails console: `AgentBot.find(2).update!(outgoing_url: 'https://NUEVO_DOMINIO/v1/webhooks/chatwoot/<pathtoken>')`
6. Mandar 1-2 mensajes reales desde el WhatsApp personal de Mariano para validar.
7. **fomo-core viejo queda corriendo en paralelo** (no se apaga) durante 48h.
8. Si todo bien después de 48h, recién jubilar fomo-core viejo.

**Rollback**: si algo se rompe, en Chatwoot via Rails console se vuelve a apuntar `outgoing_url` al endpoint viejo de fomo-core. Tiempo de rollback ~30 segundos.

## Glosario rápido

- **Agent Bot**: identidad en Chatwoot que representa a FAMA. ID 2 en `chat.fomo.com.ar`.
- **Conversation Status**: `pending` (bot maneja), `open` (humano maneja), `resolved` (cerrada), `snoozed` (pausada).
- **Path token**: token random en URL del webhook, identifica el proyecto en multi-tenancy.
- **fomo-core**: el sistema viejo que estamos reemplazando. NO mezclar código con este proyecto.
- **fomo-platform**: plataforma multi-tenant separada donde viven módulos para clientes (CRM, métricas, cotizador). NO confundir con este proyecto, son cosas distintas.
- **Hermes Agent**: framework viejo en el VPS, no relacionado con este proyecto, no integrar.

---

## Lista de pendientes Mariano (para cerrar v1)

Lo que el código no puede resolver por sí solo. Cuanto antes se haga, antes se puede activar FAMA.

### Contenido de knowledge

- [x] `src/knowledge/pricing.md` — completar valores reales de Starter / Equipo / Completo / Enterprise (precio, qué incluye, modalidad). Mientras quede TBD el agente va a responder "consultá con el equipo".
- [x] `src/knowledge/faqs.md` — completar las 9 respuestas TBD con la postura real (tiempos de implementación, contratos, canales, datos sensibles, integraciones, escalado, capacitaciones, internacional, casos de éxito).
- [x] `src/knowledge/sales.md` — refinar argumentario y casos reales si querés (el draft basado en CLAUDE.md ya es funcional).

### Configuración antes de poner en producción

- [ ] Pegar `CHATWOOT_API_TOKEN` real en `.env` (hoy está vacío — sin esto los mensajes salientes van a quedar en log warning, no llegan al cliente).
- [ ] Si va a ofrecer reuniones, completar `CALENDLY_LINK` con el link real de Cal.com de Mariano. Por ahora el backoffice ya está instruido a NO inventar URL.

### Validación pre-cutover

- [ ] Sentarse con Guille a probar ~20 conversaciones en Mastra Studio (`npm run dev` → http://localhost:4111). Foco en: arrancar conversación, delegación al backoffice, handoff con label correcta, casos límites (consultas fuera de los 3 frentes).
- [ ] Build local del container y smoke con el script: `docker network create fomo-net; docker compose up --build -d; .\scripts\smoke-webhook.ps1 -Token <real>; docker compose down`. Verificar que los 7 fixtures devuelvan 401/401/200/200/200/200/202.
- [ ] Deploy al VPS (red `fomo-net` ya existe ahí). `docker compose up -d`.
- [ ] Mandar 5-10 webhooks simulados con `curl` desde el VPS para confirmar que la red pública resuelve y los logs están limpios.

### Cutover

- [ ] En Chatwoot via Rails console, repuntar el agent bot al endpoint nuevo:
  ```ruby
  AgentBot.find(2).update!(outgoing_url: 'https://NUEVO_DOMINIO/v1/webhooks/chatwoot/<CHATWOOT_PATH_TOKEN>')
  ```
- [ ] Mandar 1-2 mensajes de prueba desde el WhatsApp personal de Mariano. Verificar que FAMA responde y, si pide humano, que escala bien (label correcta + nota privada + asignación + status open en Chatwoot).
- [ ] Dejar `fomo-core` viejo corriendo en paralelo durante 48h.
- [ ] Pasadas las 48h sin incidentes, jubilar `fomo-core`.

### Rollback (si algo se rompe en cualquier paso)

```ruby
AgentBot.find(2).update!(outgoing_url: 'https://VIEJO_DOMINIO_DE_FOMO_CORE/...')
```

Tiempo de rollback ~30 segundos. fomo-core sigue funcional hasta que se jubile explícitamente.

---

## Bitácora de cambios

| Fecha | Cambio |
|---|---|
| 2026-05-02 | Documento inicial. v1 en construcción. |
| 2026-05-02 | Path del webhook cambiado de `/api/v1/webhooks/chatwoot/:token` a `/v1/webhooks/chatwoot/:token`. Razón: `@mastra/core@1.31.0` reserva el prefix `/api/*` para sus rutas internas vía constraint de tipo en `registerApiRoute()` (`node_modules/@mastra/core/dist/server/index.d.ts:16-17`). Como Chatwoot todavía no apunta a este endpoint (fomo-core sigue activo), el cambio no tiene impacto en producción — sólo afecta el `outgoing_url` que se va a configurar en el cutover. |
| 2026-05-02 | Reemplazo de la tool custom `delegate-to-backoffice` por el patrón nativo de Mastra (supervisor agents): el recepcionista declara `agents: { backoffice }` + `memory: new Memory({ storage: LibSQLStore })`, Mastra decide la delegación basado en `description` + instructions. Razón: Mastra v1.8+ expone supervisor pattern con memory isolation, fresh thread por delegation, hooks (`onDelegationStart/Complete`) — todo lo que íbamos a reimplementar. Decisión global del proyecto: defaultear a primitivos del framework, sólo escribir custom cuando sea necesario. Deps agregados: `@mastra/memory`, `@mastra/libsql`. Tabla de tools actualizada (4 tools, no 5). Schema de env: `CHATWOOT_API_TOKEN` pasa a opcional (default `''`); la validación se mueve a call-site (`requireChatwootToken()` en `src/lib/chatwoot.ts`), así dev/Studio bootea sin token configurado y el token sólo es exigido cuando una tool real lo necesita (post de mensaje saliente, handoff de Día 3). |
| 2026-05-02 | Día 3: `chatwoot-handoff` real con 5 llamadas (ack como paso 0 + 4 canónicas). Schema agrega `ackMessage` como input requerido — el agente lo formula y la tool lo postea públicamente antes de los pasos 1-4. Output gana `replyHandled: boolean` para que el webhook handler skipee el post del texto final del agente y no duplique el mensaje al usuario. `step_failed` ahora cubre `0|1|2|3|4|null`. Lock idempotencia 60s en memoria por conversationId, se libera al fallar para permitir reintentos. Lib `src/lib/chatwoot.ts` extendida con `addChatwootLabels`, `assignChatwootTeam`, `toggleChatwootStatus`. Webhook handler en `src/server/webhook.ts` agrega `handoffAlreadyPostedAck()` que recursa sobre `toolResults` y `subAgentToolResults` para detectar el flag. Tests con `globalThis.fetch` mockeado: 6 casos cubren happy path, fallo en paso 0/1/4, idempotent skip, y release de lock al fallar. Total suite: 21/21. |
| 2026-05-02 | Día 4: knowledge-search real + 6 markdowns en `src/knowledge/` (identity, employees, services, pricing, faqs, sales). Lib `src/lib/knowledge.ts`: parsea cada md por headings `## `, score por substring case+accent-insensitive con stopwords castellanos (que/cual/como/etc) y bonus 5× cuando el match cae en el título de la sección. La tool `knowledge-search` ahora delega a `searchKnowledge(query, limit)`. Path resuelto contra `process.cwd()/src/knowledge` — `mastra dev` y los tests corren desde la raíz; en Docker (Día 5) hay que copiar la carpeta. **Pendiente Mariano**: completar valores TBD en `pricing.md` (precios reales de Starter/Equipo/Completo/Enterprise) y `faqs.md` (respuestas reales a las 9 preguntas). El skeleton refleja la estructura; el agente ya puede operar pero responderá "TBD" o "consultá con el equipo" hasta que se completen. Total suite: 28/28. |
| 2026-05-02 | Día 5: Docker. `Dockerfile` multi-stage (build → runtime, node:20-alpine), copia `src/knowledge/` al runtime para que `searchKnowledge` resuelva la path cwd-relativa dentro del container. `docker-compose.yml` referencia `fomo-net` como `external: true`, expone 4111, persiste `mastra.db` en named volume `fama-state` montado en `/app/data` con `MASTRA_DB_URL=file:/app/data/mastra.db`. `.dockerignore` excluye node_modules, tests, .agents/.claude (skills), CLAUDE.md y secrets. `MASTRA_DB_URL` agregado al schema de env (default `file:./mastra.db`). Healthcheck del container usa el `/health` **built-in de Mastra** (devuelve `{success:true}` con 200) — confirmado al inspeccionar contra el container, así que no hace falta apiRoute custom. |
| 2026-05-02 | Día 6-7: cierre de v1. Resto de tareas son operacionales y dependen de Mariano + Guille (ver "Lista de pendientes Mariano"). Código congelado a la espera de validación en Studio + smoke contra Chatwoot real antes del cutover. |
| 2026-05-02 | Calibración post-Studio dry-run #1: prompt del recepcionista exige nombre + servicio específico + plazo antes de delegar (delegaba con "IA para mi empresa"); supervisor relay verbatim post-delegación (ahorra tokens y limpia la doble respuesta visible en Studio). Backoffice exige los 5 campos obligatorios (nombre, empresa, servicio específico, canal de contacto, plazo) antes de cualquier tool, y NO reintenta `chatwoot-handoff` cuando devuelve `success: false` (en su lugar mete fallback fijo apuntando a hola@fomologic.com). |
| 2026-05-02 | Sincronización con `fama-design-v1.md` (cambios de alcance v1): (1) **`notify-mariano` ELIMINADA del v1**. Tool removida (`src/mastra/tools/notify-mariano.ts`), import + tool entry removidos del backoffice, instructions sin referencias a "casos calientes" ni Telegram. Si en v2 hace falta notificar a Mariano por canal externo, se reimplementa contra el canal definitivo (no asumimos Telegram). (2) **NURTURING entra en v1 scope** (estaba en "no en v1") — worker para revivir leads dormidos con 2 reintentos dentro de la ventana 24h Meta + horario AR; spec en `fama-design-v1.md §7`; implementación post-cutover. (3) Nuevos items en "Lo que NO va en v1": templates de Meta para reintentos >24h, inferencia de timezone del cliente, NURTURING sofisticado para humanos demorados, notificación a Mariano por canal externo. |
| 2026-05-02 | Bloque 0 del diseño v1 sincronizado: diagrama de arquitectura ahora incluye worker NURTURING y branch del primer turno hard-coded (<30 palabras). Decisiones tomadas agrega: primer turno hard-coded (umbral 30 palabras + signal "primer turno = sin `last_outbound_at` registrado"), bar mínimo del Backoffice = 4 datos (no 5), excepciones rígidas bajan el bar a "nombre + canal de contacto". Tabla de tools refleja nuevo contrato de `upsert-twenty-lead` con `stage` enum. NURTURING deja de estar marcado "post-cutover" — entra en este sprint. `fama-design-v1.md §9` actualizado para reflejar la signature real de `chatwoot-handoff` con `ackMessage` (el diseño tenía un input desactualizado). Cambios de código vienen en bloques 1-4 separados. |
| 2026-05-03 | Backoffice subido a `gpt-4o` (recepcionista se mantiene en `gpt-4o-mini`). Razón: decision tree denso del backoffice (4 arquetipos × 5 excepciones × 6 stages + armado de nota privada estructurada) requiere mejor seguimiento de instrucciones que mini. Costo extra estimado USD 5-15/mes con volumen inicial. Decisión tomada como D1 del plan de cutover (ver PLAN-FAMA-V1-CUTOVER.md). Suite de tests: 88/88 verdes, typecheck limpio. |
| 2026-05-03 | Dedupe de mensajes entrantes implementado en `src/lib/dedup-store.ts`. Tabla `processed_messages` en `mastra.db`. TTL 5 min, cleanup setInterval cada 30 min (skip en test). Idempotencia atómica vía INSERT OR IGNORE en `tryMarkProcessed`. Hook en webhook handler después del filtrado de 6 reglas y antes del welcome/agente. Razón: Chatwoot puede retransmitir eventos por timeout, sin dedupe FAMA mandaría 2 respuestas al mismo mensaje. Decisión D3 del plan de cutover. |
| 2026-05-03 | Knowledge content: `pricing.md` y `faqs.md` completados con datos reales. Pricing refleja los 4 planes del sitio (Starter USD 299 / Equipo USD 699 / Completo USD 1.099 / Enterprise a convenir) + setup únicos + factores que justifican el "desde" (integraciones + empleado puntual). FAQs cubre las 9 categorías originales del CLAUDE.md + 9 más útiles tomadas del sitio web, con tono ajustado para FAMA (sin slogans ni promesas de SLA). Datos sensibles redactado cauto sin sobre-prometer; escalado a humano confirma derivación; capacitaciones desde USD 1.000; casos de éxito redactado vago para no comprometer volumen. `sales.md` queda pendiente para próxima sesión. |
| 2026-05-03 | `sales.md` completado, paso 4 cerrado completo. Estructura: 8 secciones h2 (Por qué FOMO / ChatGPT / costo de no automatizar / discovery / 3 objeciones promovidas a h2 / proceso). Contenido refinado en sesión: framing "herramienta vs sistema" para diferenciación con ChatGPT, redefinición de "caro" basada en costo de empleados poco productivos, técnica de discovery "magia para resolver un problema". Sección "Cuándo FOMO no es la mejor opción" eliminada (contradice estrategia de captura amplia documentada). ~700 palabras. Las 3 objeciones quedaron como h2 (no h3) siguiendo el aprendizaje de `pricing.md` para que el parser de knowledge las indexe individualmente. |

A medida que tomemos decisiones nuevas o cambien las existentes, anotar acá con fecha breve.