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
WhatsApp → Chatwoot → webhook → Recepcionista (FAMA, supervisor)
                                       │
                                       ├─ knowledge-search (info de FOMO)
                                       │
                                       └─ delega al subagente Backoffice
                                              (vía patrón nativo de Mastra: `agents: { backoffice }` + Memory)
                                              │
                                              ├─ knowledge-search
                                              ├─ chatwoot-handoff (escalar a humano)
                                              ├─ upsert-twenty-lead (CRM, mock en v1)
                                              └─ notify-mariano (Telegram, mock en v1)
```

- **Recepcionista (FAMA, supervisor)**: conversa, hace discovery, identifica intención. Cuando hay venta clara, delega al backoffice usando el patrón nativo de Mastra — no una tool custom.
- **Backoffice (subagente)**: especialista de ventas. Decide si escalar al humano, guardar lead, notificar.

## Stack y restricciones

- **Framework**: Mastra (usar el skill instalado para todas las APIs).
- **Lenguaje**: TypeScript con ES2022 (requirement de Mastra).
- **Modelo**: `openai/gpt-4o-mini` para ambos agentes en v1. Configurar via Mastra model router (`provider/model-name`).
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
CHATWOOT_PATH_TOKEN=<CONFIGURAR_EN_ENV>
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
3. `body.event !== 'message_created'` → `200` silencioso.
4. `body.messages?.[0]?.message_type !== 0` (donde 0 = incoming) → `200`.
5. `body.messages?.[0]?.sender?.type !== 'contact'` → `200`.
6. Contenido vacío o solo whitespace → `200`.

Recién después de esto, invocar al agente.

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
| `upsert-twenty-lead` | Mock (console.log + return success) | Solo Backoffice |
| `notify-mariano` | Mock (console.log + return success) | Solo Backoffice |

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
- **gpt-4o-mini** para ambos agentes en v1.
- **Sin retry automático** en handoff. Falla → log ERROR → reintentos vienen del flujo natural del agente.
- **Lock interno de 60s** para idempotencia (no chequeo contra Chatwoot).
- **Mocks de Twenty y Telegram** en v1, integración real en v2.
- **Sin Slack** en absoluto (era deuda del sistema viejo).
- **Mensaje de acknowledge inmediato** cuando el backoffice escala. Implementado como paso 0 de `chatwoot-handoff` (la tool recibe `ackMessage` por parámetro y lo postea como mensaje público antes de la secuencia 1-4). El webhook handler skipea el post del texto final del agente cuando detecta `replyHandled: true` para no duplicar.
- **Calendly link**: vendrá un Cal.com personal de Mariano. Por ahora dejar como variable `CALENDLY_LINK` en config, vacío por defecto. Cuando esté el link real, se conecta. **No hardcodear ningún link** en prompts ni código.

## Lo que NO va en v1

No construyas estas cosas, son v2 explícitamente:

- Worker NURTURING / Tamagotchi (revivir leads dormidos).
- Debouncing / batching de mensajes seguidos.
- Conexión real a Twenty CRM.
- Conexión real a Telegram.
- Métricas en `fomo-platform`.
- Pre-flight validation de tools.
- ToolPacks como abstracción.
- Conversaciones protegidas con label `no-bot`.
- Handoff inverso sofisticado (reaperturas con heurística de tiempo).
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

## Bitácora de cambios

| Fecha | Cambio |
|---|---|
| 2026-05-02 | Documento inicial. v1 en construcción. |
| 2026-05-02 | Path del webhook cambiado de `/api/v1/webhooks/chatwoot/:token` a `/v1/webhooks/chatwoot/:token`. Razón: `@mastra/core@1.31.0` reserva el prefix `/api/*` para sus rutas internas vía constraint de tipo en `registerApiRoute()` (`node_modules/@mastra/core/dist/server/index.d.ts:16-17`). Como Chatwoot todavía no apunta a este endpoint (fomo-core sigue activo), el cambio no tiene impacto en producción — sólo afecta el `outgoing_url` que se va a configurar en el cutover. |
| 2026-05-02 | Reemplazo de la tool custom `delegate-to-backoffice` por el patrón nativo de Mastra (supervisor agents): el recepcionista declara `agents: { backoffice }` + `memory: new Memory({ storage: LibSQLStore })`, Mastra decide la delegación basado en `description` + instructions. Razón: Mastra v1.8+ expone supervisor pattern con memory isolation, fresh thread por delegation, hooks (`onDelegationStart/Complete`) — todo lo que íbamos a reimplementar. Decisión global del proyecto: defaultear a primitivos del framework, sólo escribir custom cuando sea necesario. Deps agregados: `@mastra/memory`, `@mastra/libsql`. Tabla de tools actualizada (4 tools, no 5). Schema de env: `CHATWOOT_API_TOKEN` pasa a opcional (default `''`); la validación se mueve a call-site (`requireChatwootToken()` en `src/lib/chatwoot.ts`), así dev/Studio bootea sin token configurado y el token sólo es exigido cuando una tool real lo necesita (post de mensaje saliente, handoff de Día 3). |
| 2026-05-02 | Día 3: `chatwoot-handoff` real con 5 llamadas (ack como paso 0 + 4 canónicas). Schema agrega `ackMessage` como input requerido — el agente lo formula y la tool lo postea públicamente antes de los pasos 1-4. Output gana `replyHandled: boolean` para que el webhook handler skipee el post del texto final del agente y no duplique el mensaje al usuario. `step_failed` ahora cubre `0|1|2|3|4|null`. Lock idempotencia 60s en memoria por conversationId, se libera al fallar para permitir reintentos. Lib `src/lib/chatwoot.ts` extendida con `addChatwootLabels`, `assignChatwootTeam`, `toggleChatwootStatus`. Webhook handler en `src/server/webhook.ts` agrega `handoffAlreadyPostedAck()` que recursa sobre `toolResults` y `subAgentToolResults` para detectar el flag. Tests con `globalThis.fetch` mockeado: 6 casos cubren happy path, fallo en paso 0/1/4, idempotent skip, y release de lock al fallar. Total suite: 21/21. |

A medida que tomemos decisiones nuevas o cambien las existentes, anotar acá con fecha breve.