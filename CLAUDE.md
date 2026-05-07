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

| Tool | Estado | Quién la usa |
|---|---|---|
| `knowledge-search` | Real (v1) | Recepcionista + Backoffice |
| `chatwoot-handoff` | Real (v1) | Solo Backoffice |
| `upsert-twenty-lead` | Real (v2 Sprint 1) — Twenty self-hosted, ver sección "Twenty CRM" | Solo Backoffice + worker NURTURING |

## Twenty CRM (v2 — Sprint 1)

Reemplazo del mock de `upsert-twenty-lead` por integración real contra Twenty self-hosted en `https://crm.fomo.com.ar`.

**Endpoints**:
- Data API: `https://crm.fomo.com.ar/rest` (Person, Company, Opportunity, Note, NoteTarget). Auth: `Authorization: Bearer <TWENTY_API_KEY>`.
- Metadata API: `https://crm.fomo.com.ar/rest/metadata` (objects, fields). Misma auth.

**Schema en Twenty (creado en este sprint vía metadata API)**:

- Stage enum extendido a 8 valores: `NEW | CONTACTED | SCREENING | MEETING | PROPOSAL | WON | CUSTOMER | LOST`. SCREENING y CUSTOMER quedan como aliases legacy (mapean a CONTACTED y WON respectivamente en `src/lib/twenty.ts → aliasStage`).
- 6 custom fields creados:
  - `Person.whatsappUrl` (TEXT) — link a la conversación de Chatwoot.
  - `Person.firstContactAt` (DATE_TIME) — primer mensaje del cliente.
  - `Person.lastContactAt` (DATE_TIME) — último mensaje del cliente. Se actualiza siempre.
  - `Person.messageCount` (NUMBER) — counter incremental. Se actualiza siempre.
  - `Opportunity.arquetipo` (SELECT, nullable) — `CALIENTE | A_EXPLORAR | SIN_CLARIDAD | NO_LEAD`. Set por el backoffice.
  - `Opportunity.exception` (SELECT, nullable) — `PEDIDO_HUMANO | CONSULTORIA | URGENCIA | RECLAMO | DEMO`. Set por el backoffice cuando aplica una excepción rígida.
- `Opportunity.sourceChannel` ya existía nativo (`WHATSAPP | WEBSITE | INSTAGRAM | LINKEDIN | REFERRAL | EMAIL | ADS | OTHER`) — lo reusamos en lugar de crear un custom `source`.

**Owner**: `accountOwnerId` se aplica solo a Company (Person/Opportunity no tienen field nativo de owner). El env var `TWENTY_OWNER_USER_ID` guarda el `workspaceMember.id` (NO el `User.id` interno — pasarlo causa FK error 500). El valor real para Mariano es `44f3a96e-dba6-4bac-8826-166f58bee218`.

**Lógica de upsert** (en `src/mastra/tools/upsert-twenty-lead.ts → runUpsertTwentyLead`):

1. `findPersonByPhone(phone)` (lookup por `phones.primaryPhoneNumber[eq]:<national-number>`).
2. Si hay company: `findCompanyByName(name)` o `createCompany` con `accountOwnerId`.
3. Si Person no existe: `createPerson` con todos los datos + `firstContactAt=now`, `lastContactAt=now`, `messageCount=1`.
4. Si Person existe: **merge inteligente** — solo seteamos campos que están vacíos en Twenty (`name`, `email`, `companyId`, `whatsappUrl`). `lastContactAt` y `messageCount` se actualizan SIEMPRE.
5. `findOpportunityByPersonId(personId)`. Si no existe: `createOpportunity`. Si existe: `updateOpportunity` solo si `canAdvanceStage(current, new)` — el stage **solo avanza, nunca retrocede** (LOST es siempre alcanzable; WON solo permite WON o LOST).
6. Si `notes` viene en el input: `createNote` + `attachNoteToPerson` (Twenty necesita 2 calls — Note + NoteTarget separados). Falla en Note es no-fatal: el lead queda registrado igual.

**Manejo de errores**:
- Cliente HTTP en `src/lib/twenty.ts`: retry 3 intentos con backoff 5s/10s/15s para 5xx y network errors. **4xx no retry** — son bugs nuestros.
- Si todos los retries fallan, la tool retorna `{ success: false, error }`. La conversación con el cliente sigue normal — Twenty no bloquea.
- Si `TWENTY_API_KEY` está vacío (dev/Studio), la tool retorna `{ success: true, skipped: true }` y loguea warning. Booteo no falla.

**Inputs del LLM** (post-v2): `{ name?, email?, company?, stage, source, notes?, arquetipo?, exception? }`. **`phone` y `conversationId` NO los pasa el LLM** — los inyecta el webhook handler vía `RequestContext` desde `sender.phone_number` del payload de Chatwoot. Esto evita alucinaciones de phone en Studio o prompts parciales.

**Para el worker NURTURING (LOST)**: el `phone` ahora se guarda en la tabla `nurturing_conversations` (columna agregada en migración idempotente). Cuando el worker marca un lead como LOST tras 24h sin respuesta, llama `runUpsertTwentyLead({ stage: 'LOST', ... })` con el phone real del row. Si el row es de v1 sin phone, skipea el upsert con warning.

## Multimodalidad (v2 — Sprint 2)

WhatsApp manda audios (`.opus` / `.ogg`) e imágenes (`.jpg` / `.png` / `.webp`) que llegan a FAMA con `content` vacío y el archivo en `messages[0].attachments[0].data_url`. Sprint 2 transcribe / describe esos archivos y los inyecta como texto al pipeline normal — recepcionista y backoffice siguen viendo strings y nada cambia para ellos.

**Tipos soportados**:
- `audio` → Whisper-1 transcribe a castellano (idioma fijo `es`).
- `image` → gpt-4o vision describe en 1-3 oraciones (también castellano).
- `video`, `file`, `fallback` → no procesados; cae en filter rule 6 si el mensaje no tiene texto.

**Flow del webhook con attachments**:

1. `extractMessage` extrae `attachments[]` raw del payload.
2. `processAttachments` (en `src/lib/attachment-processor.ts`):
   - Audio: descarga el blob desde Chatwoot (`fetch` sin auth — Active Storage es signed pero público, timeout 15s) → `transcribeAudio()` → texto.
   - Imagen: pasa la URL directo a `describeImage()` — gpt-4o vision consume URLs públicas, no hace falta bajar.
   - Caps duros antes del call a OpenAI: 5MB audio (~5min de opus, margen sobre los 60s reales esperados), 10MB imagen.
   - Fallos devuelven placeholder (`[audio del cliente, no se pudo transcribir]`, etc.) — la conversación nunca se rompe por culpa de media.
3. `effectiveContent` reemplaza al `content` original con la concatenación: `texto original (si lo había) + [audio del cliente]: <transcripción> + [imagen del cliente]: <descripción>`.
4. **Welcome path skipea cuando `hasMedia=true`** (D4 del sprint). Razón: un audio "hola" de 2 palabras igual merece LLM, porque el welcome NO escribe en Memory de Mastra — si saltáramos el LLM, el segundo turno del cliente vendría sin contexto del primero. Texto puro <30 palabras y primer turno → welcome como antes.
5. LLM normal procesa el `effectiveContent`. Memory captura todo el thread.
6. **Después del LLM, sync de attachments a Twenty** (CLAUDE.md "guardar todos en CRM" — D3 del sprint): `findOrCreatePersonByPhone` (si no existe Person, lo creamos mínimo con stage NEW + `firstName='Anónimo'`) y `createAttachment` por cada audio/imagen. `fullPath` = `data_url` de Chatwoot, `fileCategory` = `AUDIO` / `IMAGE`. Errores son no-fatales y solo loggean.

**Filter rule 6 ajustada** (en `src/server/filter.ts`): mensajes con `content` vacío PASAN el filtro si tienen al menos un attachment de tipo `audio` o `image`. Video-only sigue rechazado con `empty_content` (sin pre-procesador para video en v2).

**Caveat conocido — `fullPath` apunta a Chatwoot**: el link al attachment en Twenty UI requiere que el visitante esté logged en Chatwoot. Twenty REST no expone endpoint de upload de blob, así que para v2 dejamos el link tal cual. Si en v3 querés ver attachments "en frío", hay que subir a un bucket propio (S3/etc) y guardar esa URL en lugar de la de Chatwoot.

**Costos** (orden de magnitud, sin volumen real todavía):
- Audio: ~USD 0.006/min en Whisper. Un audio típico de 15s ~USD 0.0015.
- Imagen: ~USD 0.005 por imagen estándar en gpt-4o vision input.

**Dep nueva**: `openai@6.x` (oficial). Es la primera vez que se usa el SDK directo de OpenAI en este proyecto — el resto del código sigue usando Mastra para el agente. La razón de tener ambos es que Whisper requiere multipart upload (fetch crudo se vuelve feo) y vision tiene un schema más limpio en el SDK.

## Calendar Agent (v2 — Sprint 3)

Cuando el backoffice detecta intención de demo (Excepción 5 con Nivel 2 OK, o Arquetipo 1 caliente), delega a un sub-subagente **Agendador** que coordina la demo con calendar real (Google Calendar de Mariano + Guille en el Workspace de `fomo.com.ar`). El agendador pide email, ofrece 2 slots libres, agenda con Meet auto-generado y sincroniza Twenty + Chatwoot. **No escala humano cuando el booking sale OK** — la reserva exitosa cierra el loop.

**Estructura**:
```
Recepcionista (supervisor)
   └── Backoffice (subagente)
          └── Agendador (sub-subagente — gpt-4o-mini, scope acotado)
```

**Auth**: service account JSON con **Domain-Wide Delegation** (DWD). El SA impersona al usuario que figura en `CALENDAR_PRIMARY` (ej `mariano@fomo.com.ar`) — es decir, las llamadas a Calendar API se hacen "como" Mariano. Esto evita depender del sharing UI de Calendar (la External sharing policy del Workspace típicamente bloquea "Make changes to events" para emails externos como `*@*.iam.gserviceaccount.com`, y la propagación de cambios en esa policy puede tardar hasta 24h).

> **Por qué DWD y no sharing explícito**: en el primer intento usamos sharing manual del calendar con el SA. Pero el Workspace tenía la External sharing policy en "Only free/busy" y aunque se cambió la policy, los sharings con dominios externos se degradan/restringen y no permiten escritura. DWD bypaesa eso completamente — el SA actúa como un user del Workspace, no como un colaborador externo. Decidido y validado el 2026-05-07.

**Setup operacional** (NO codeable, depende de Mariano — ver "Lista de pendientes Mariano → Sprint 3" abajo):
1. Proyecto en `console.cloud.google.com`.
2. Habilitar Google Calendar API.
3. IAM → Service Accounts → Create → generar JSON key.
4. **NO** hace falta compartir cada calendar con el SA — DWD lo cubre.
5. **Habilitar Domain-Wide Delegation** en el SA (paso clave):
   - Anotar el `client_id` numérico del SA (está en el JSON, campo `client_id`).
   - Ir a `https://admin.google.com/ac/owl/domainwidedelegation` (logged como super-admin del Workspace).
   - "+ Añadir nuevo" → pegar el `client_id` + scope `https://www.googleapis.com/auth/calendar` → Autorizar.
6. Pegar JSON completo en `.env` como `GOOGLE_CALENDAR_CREDENTIALS_JSON` (sola línea).
7. Pegar emails en `.env`:
   - `CALENDAR_IDS_TO_CHECK="mariano@fomo.com.ar,guille@fomo.com.ar"` (intersección de busy times — ambos calendars deben estar en el mismo Workspace que autorizó la DWD)
   - `CALENDAR_PRIMARY=mariano@fomo.com.ar` (el SA impersona ESTE user; los eventos se crean en su calendar, el otro va como attendee)
8. Si sólo querés que el SA pueda crear eventos en el calendar de Mariano pero leer disponibilidad de Guille, asegurate que Guille tiene **compartido su calendar con Mariano** dentro del Workspace (sharing interno, sin restricciones). Como el SA impersona a Mariano, ve los calendars que Mariano ve.

**Reglas de negocio** (`src/lib/availability.ts`):
- Duración fija: **30 min**.
- Buffer fijo: **15 min** antes y después del slot — un slot solo aparece si está libre incluyendo el buffer en ambos calendars.
- Horario laboral: **9-19hs UTC-3** (mismo que NURTURING). Argentina sin DST → offset fijo.
- **Nunca slots del mismo día**. El primer slot ofrecido es siempre día siguiente o más adelante a las 9am AR. Sábados y domingos saltean a lunes.
- Ventana de búsqueda: **7 días** desde mañana.
- Default ofrecidas: **2 opciones por turno**. El prompt sube a 3 si el cliente rechazó las primeras 2.

**Tools del agendador**:
- `list-calendar-slots` (`src/mastra/tools/list-calendar-slots.ts`): wrapper sobre `freebusy.query` que devuelve los próximos N slots libres con `slotStartMs` (epoch para usar verbatim) + `humanLabel` (ej "martes 7 de mayo a las 11:00hs (UTC-3)") + iso strings.
- `book-calendar-event` (`src/mastra/tools/book-calendar-event.ts`): la tool central. Ejecuta:
  1. Re-verifica slot libre (race-condition guard entre el list-slots anterior y este turno).
  2. `events.insert` con `conferenceDataVersion=1` + `createRequest` para Meet auto-generado. `sendUpdates=all` → Calendar manda mails a los invitados. Attendees = Guille (calendars de check distintos al primary) + email del cliente.
  3. Twenty: `findOrCreatePersonByPhone` (Person mínimo si no existía) → `findOpportunityByPersonId` → si existe, `updateOpportunity` con stage=MEETING + arquetipo=CALIENTE (respetando `canAdvanceStage` — no degradamos PROPOSAL); si no existe, `createOpportunity` con esos valores. `createNote` + `attachNoteToPerson` con detalle del evento (link Meet, link Calendar, contexto del lead).
  4. Chatwoot: `sendChatwootMessage` private=true con detalle estructurado al equipo + `addChatwootLabels` con `venta-{capacitacion|agentes|consultoria}` según el frente. **NO** `toggle_status: open` (D3 del sprint — la reserva cierra el loop sin saturar el inbox del equipo). **NO** mensaje al cliente (Calendar ya manda el mail con el link de Meet — doble confirmación es ruido).
- `chatwoot-handoff`: fallback usado cuando el agendador NO puede cerrar (Calendar no configurado, sin slots, slot taken repetidos, cliente rechazó todas las opciones, etc.).

**Manejo de errores**:
- Calendar no configurado → `success=false, reason='calendar_not_configured'`. El agendador escala vía chatwoot-handoff.
- Slot tomado entre list y book → `reason='slot_taken'`. El agendador pide nuevos slots y reintenta.
- Calendar API caído → `reason='calendar_api_error'`. Escala humano.
- **Twenty / Chatwoot fallan después del Calendar** → `success=true` igual. El evento ya está creado y el cliente recibió el mail; no tiene sentido reventar el flow. Solo se loggea ERROR.

**Inputs vs RequestContext**:
- Lo que el LLM pasa: `slotStartMs` (verbatim del list-slots), `customerName`, `customerEmail`, `category` (label Chatwoot), `summary`, `contextNote`.
- Lo que viene por RequestContext: `phone`, `conversationId`, `contactName`. Igual que las otras tools — evita alucinaciones.

**Costo**: gpt-4o-mini para el agendador (scope simple), free el calendar API hasta cuotas razonables. El esfuerzo agregado por demo agendada es ~3-6 turnos cortos del LLM.

**Lo que NO hace el agendador en v3**:
- No mueve ni cancela eventos. Si el cliente quiere reprogramar, escalá a humano.
- No detecta cancelaciones hechas vía Calendar UI — Twenty/Chatwoot quedan desactualizados si Mariano/Guille cancelan a mano. Para v4 si pasa con frecuencia: webhook push de Calendar → endpoint nuestro → revertir stage a CONTACTED.

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
- **Twenty real** desde v2 Sprint 1 (2026-05-05). Reemplaza el mock de v1. Ver sección "Twenty CRM (v2 — Sprint 1)" arriba.
- **Multimodalidad (audio + imagen)** desde v2 Sprint 2 (2026-05-06). Audios via Whisper, imágenes via gpt-4o vision; ambos se transcriben/describen a texto antes del LLM y se guardan como attachment en Twenty. Welcome path skipea cuando hay media para no perder info. Ver sección "Multimodalidad (v2 — Sprint 2)" arriba.
- **Calendar agent** desde v2 Sprint 3 (2026-05-07). Sub-subagente Agendador coordina demos con Google Calendar real (Mariano + Guille en Workspace fomo.com.ar) usando service account. Slots de 30 min, buffer 15 min, no mismo día, ventana 7 días, 2 opciones por turno. Si el booking sale OK no escala humano (loop cerrado). Ver sección "Calendar Agent (v2 — Sprint 3)" arriba.
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
- ~~Conexión real a Twenty CRM (sigue como mock).~~ **Hecho en v2 Sprint 1 (2026-05-05).**
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

### Validación pre-cutover (v2 Sprint 1 — Twenty)

- [ ] Smoke real con WhatsApp: dejar el contenedor corriendo, mandarte 1-2 mensajes desde tu WhatsApp personal y verificar en Twenty UI:
  - Person creado con `phones.primaryPhoneNumber`, `whatsappUrl` clickeable a Chatwoot, `firstContactAt`, `lastContactAt`, `messageCount`.
  - Opportunity creada con `stage`, `sourceChannel=WHATSAPP`, owner = vos (vía Company.accountOwnerId si pasaste empresa).
  - Si pediste hablar con humano: stage=MEETING, `exception=PEDIDO_HUMANO`, Note adjunta al Person con el resumen.
- [ ] Si el smoke aparece OK pero querés que la API key se rote (recomendado, ya quedó pegada en el chat de Claude Code), generá una nueva en `https://crm.fomo.com.ar/settings/api-webhooks`, pegala en `.env`, y reiniciá el contenedor.

### Setup + validación (v2 Sprint 3 — Calendar agent)

Setup en GCP (sin esto el agendador retorna `calendar_not_configured` y escala humano):

- [x] **Crear proyecto en `console.cloud.google.com`** (Hecho 2026-05-07: proyecto `fama-mastra`, ID `78931514184`).
- [x] **APIs & Services → Library → habilitar Google Calendar API** (Hecho 2026-05-07).
- [x] **IAM & Admin → Service Accounts → Create service account** (Hecho 2026-05-07: `fama-agendador@fama-mastra.iam.gserviceaccount.com`).
- [x] **Si tu organización tiene la policy `iam.disableServiceAccountKeyCreation` activa** (defecto en Workspaces nuevos): asignarte rol `roles/orgpolicy.policyAdmin` a nivel organización + `gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --project=<PROJECT_ID>` (Hecho 2026-05-07).
- [x] **Generar JSON key del SA** → bajarla → pegar en `.env` como `GOOGLE_CALENDAR_CREDENTIALS_JSON` (Hecho 2026-05-07).
- [x] **Habilitar Domain-Wide Delegation en el SA** (Hecho 2026-05-07):
  - URL directa: `https://admin.google.com/ac/owl/domainwidedelegation` (con cuenta super-admin del Workspace).
  - "+ Añadir nuevo" → ID de cliente: el `client_id` numérico del SA (campo del JSON, NO el email) → OAuth scopes: `https://www.googleapis.com/auth/calendar` → Autorizar.
- [x] **Pegar emails en `.env`** (Hecho 2026-05-07):
  ```
  CALENDAR_IDS_TO_CHECK=mariano@fomo.com.ar,guille@fomo.com.ar
  CALENDAR_PRIMARY=mariano@fomo.com.ar
  ```
- [ ] **Pendiente**: confirmar email exacto del calendar de Guille (`guille@fomo.com.ar` retorna `notFound` en freebusy — puede ser otro alias). Mientras tanto el agendador funciona contra el calendar de Mariano solamente.

**Sanity end-to-end** (validado 2026-05-07): `npx -y tsx --env-file=.env scripts/sanity-calendar.ts` crea + borra evento de prueba con Meet auto-generado en el calendar de Mariano. ALL OK.

Smoke con WhatsApp (asumiendo que ya hiciste los smokes de Sprint 1 + 2):

- [ ] Mandate "necesito una demo" como cliente nuevo desde tu WhatsApp. El backoffice debería hacer discovery y, cuando tenga Nivel 2, delegar al agendador.
- [ ] El agendador te debería pedir email. Dale uno real.
- [ ] El agendador te debería ofrecer 2 slots reales libres en tu calendar. Verificá en Calendar UI que esos horarios están efectivamente libres (no tenés eventos ni vos ni Guille).
- [ ] Elegí uno de los 2.
- [ ] Verificá:
  - Calendar: aparece el evento en tu calendar (y en el de Guille, como invitada). El evento tiene Meet link auto-generado.
  - Mail: te llegó el mail de Calendar con el evento + link de Meet. Y al cliente también.
  - Twenty: Person actualizado, Opportunity con `stage=MEETING` + `arquetipo=CALIENTE`, Note con detalle del evento.
  - Chatwoot: nota privada en la conversación con fecha + hora + frente + link Meet, label `venta-{frente}`. Conversation status sigue **pending** (no abierto a humano).
  - Logs del contenedor: `book-calendar-event: Calendar event created`, sin errores en Twenty / Chatwoot sync.

### Validación pre-cutover (v2 Sprint 2 — Multimodalidad)

- [ ] Smoke con audio: mandate un audio de WhatsApp diciendo algo concreto ("hola, soy Mariano de FOMO, quiero info"). Verificar:
  - FAMA responde algo coherente con la transcripción (no un welcome genérico).
  - En Twenty: Person con `messageCount` incrementado, attachment AUDIO adjunto con `fullPath` que abre el .ogg en Chatwoot al hacer click.
  - En logs del contenedor: línea `webhook: attachments processed` con `mediaCount: 1`, `hasMedia: true`. Si la transcripción falló, línea de Whisper con error visible.
- [ ] Smoke con imagen: mandate una foto de algo (un cartel, un screenshot). Verificar:
  - FAMA responde describiendo lo que ve / contestando sobre la imagen.
  - En Twenty: Person con attachment IMAGE adjunto, link al .jpg.
  - Logs muestran descripción no vacía.
- [ ] Smoke con audio + texto en la misma tanda: mandate audio y a continuación texto. Verificar que el LLM tiene contexto de los dos turnos.
- [ ] (opcional) Smoke con video: mandate un video. Verificar que FAMA NO responde (filter rule 6 lo rechaza por `empty_content`) — comportamiento esperado en v2.
- [ ] Confirmar costos: revisar dashboard de OpenAI a las 24-48h para ver el spend por Whisper + vision con tu volumen real.

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
| 2026-05-07 | **Setup GCP + fix de auth Calendar a Domain-Wide Delegation**. Diagnóstico operacional al hacer el setup real: (1) la policy `iam.disableServiceAccountKeyCreation` está enforced por default en Workspaces nuevos — bypass con `gcloud resource-manager org-policies disable-enforce ... --project=fama-mastra` después de auto-asignarse `roles/orgpolicy.policyAdmin` a nivel organización vía `gcloud organizations add-iam-policy-binding 24355056590`. (2) **El sharing explícito del calendar con el email del SA NO funcionó** porque la External sharing policy del Workspace estaba en "Only free/busy" y aunque se cambió a "Share all information, and allow management of calendars" desde admin.google.com, los sharings con dominios externos (como `*@*.iam.gserviceaccount.com`) se siguen restringiendo y no permiten "Make changes to events" — la propagación de cambios en esa policy puede tardar hasta 24h y a veces no se aplica en absoluto. (3) **Solución**: migrar a Domain-Wide Delegation. El SA actúa como `mariano@fomo.com.ar` (impersonation) en lugar de actuar como sí mismo. Cambio de código mínimo: agregar `subject: config.primaryCalendarId` al constructor de `JWT` en `src/lib/google-calendar.ts`. Setup operacional: Client ID del SA (numérico, distinto al email) + autorizar en `https://admin.google.com/ac/owl/domainwidedelegation` con scope `https://www.googleapis.com/auth/calendar`. Sanity end-to-end real (`scripts/sanity-calendar.ts` nuevo): freebusy → 23 busy intervals reales, slots correctos AR business hours, create event con Meet auto-generado, delete cleanup — ALL OK. CLAUDE.md actualizado con el setup correcto + checklist marcado como hecho. **Pendiente menor**: el calendar de Guille (`guille@fomo.com.ar`) retorna `notFound` — confirmar email correcto. El código maneja esto gracefully (skip + warning) y el agendador funciona igual contra el calendar de Mariano. |
| 2026-05-07 | **v2 Sprint 3 — Calendar agent nativo**. Decisiones del sprint: (D1) Opción C — calendar nativo en lugar de link Calendly. Mariano descarta Calendly directamente; FAMA lee el calendar real (Workspace fomo.com.ar) y agenda. (D2) Sub-subagente "agendador" separado del backoffice. Razón: el backoffice ya está cargado (4 arquetipos × 5 excepciones × stage management). Agregar el flow conversacional de slots/booking lo volvía frágil. El agendador hereda el thread Memory del backoffice → no perdemos contexto. (D3) Si el booking sale OK NO escala humano — la reserva cierra el loop sin saturar el inbox del equipo. (D4) Twenty stage=MEETING + arquetipo=CALIENTE + Note con detalle. Chatwoot nota privada al equipo + label `venta-{frente}`. NO mensaje al cliente (Calendar ya manda mail con Meet — doble confirmación es ruido). (Auth) Service account JSON sin domain-wide delegation; cada calendar comparte explícito con el email del SA. Más simple que OAuth user. **Reglas de negocio**: 30 min duración, 15 min buffer, no mismo día, 9-19hs UTC-3, ventana 7 días, 2 slots por turno. Argentina sin DST → offset fijo. **Cambios de código**: `src/lib/google-calendar.ts` nuevo (cliente JWT + freebusy + insertEvent con Meet via `createRequest` + cancelEvent); `src/lib/availability.ts` nuevo (lógica pura: `startOfNextBusinessDay`, `generateCandidateSlots`, `isSlotFree`, `findAvailableSlots`, `formatSlotForHumans`); `src/mastra/tools/list-calendar-slots.ts` nuevo; `src/mastra/tools/book-calendar-event.ts` nuevo (race-condition guard + Calendar event + Twenty sync best-effort + Chatwoot sync best-effort); `src/mastra/agents/agendador.ts` nuevo (gpt-4o-mini, prompt acotado al flow email→slots→book); `src/mastra/agents/backoffice.ts` con `agents: { agendador }` + Excepción 5 y Arquetipo 1 ahora delegan al agendador en lugar de chatwoot-handoff directo; `src/mastra/index.ts` registra el agendador. **Env vars**: `GOOGLE_CALENDAR_CREDENTIALS_JSON`, `CALENDAR_IDS_TO_CHECK`, `CALENDAR_PRIMARY`. Todos opcionales — si vacíos el agendador escala humano. **Dep nueva**: `googleapis@171.x` oficial. **Tests**: `tests/lib/availability.test.ts` (21 tests puros — startOfNextBusinessDay con weekday/Friday→Monday/Saturday→Monday/Sunday→Monday/early hour same day, generateCandidateSlots con 7 días skipeando weekend, isSlotFree con buffer en ambos lados, findAvailableSlots con calendars vacíos / parcialmente busy / cross-day / fully booked, formatSlotForHumans en castellano AR). `tests/mastra/tools/list-calendar-slots.test.ts` (6 tests con mocks: not configured → reason, sin busy → 2 slots, count=3, API error, unknown error, sin slots libres). `tests/mastra/tools/book-calendar-event.test.ts` (10 tests con mocks de google-calendar/twenty/chatwoot: pre-flight not configured, slot taken, freebusy error; happy path crea Calendar event + Twenty Opp con MEETING/CALIENTE + Note + Chatwoot nota privada + label `venta-agentes`; updateOpportunity en lugar de create cuando ya existe; canAdvanceStage bloquea downgrade desde PROPOSAL; success=true igual cuando Twenty/Chatwoot fallan; success=false cuando Calendar createEvent falla). Total suite: **190/190 verde**, typecheck limpio. Pendiente Mariano: setup GCP (proyecto + Calendar API + service account + JSON key + share calendars) — sin eso el agendador retorna `calendar_not_configured` y escala. Sanity end-to-end real **NO** ejecutado este sprint (sin credenciales) — Mariano hace smoke con WhatsApp real cuando tenga el SA. |
| 2026-05-06 | **v2 Sprint 2 — Multimodalidad (audios + imágenes)**. Decisiones del sprint: (D1) Audios → Whisper-1 con `language='es'` fijo, transcripción reemplaza al `content` vacío del payload. (D2) Imágenes → gpt-4o vision describe en 1-3 oraciones; vision consume URL pública directo, no hace falta bajar el blob. (D3) Todos los attachments soportados (AUDIO/IMAGE) se guardan en Twenty como `Attachment` asociado al Person, con `fullPath` apuntando al `data_url` de Chatwoot — `findOrCreatePersonByPhone` crea Person mínimo "Anónimo" si no existe. (D4) Welcome path hard-coded skipea cuando `hasMedia=true` para no perder info — un audio "hola" igual va al LLM, así Memory de Mastra captura el thread y el segundo turno tiene contexto. **Caps duros**: 5MB audio (~5min de opus), 10MB imagen (límite gpt-4o vision). **Filter rule 6 ajustada**: mensajes con `content` vacío PASAN si tienen attachment de tipo `audio` o `image`; `video`/`file`/`fallback` siguen rechazados con `empty_content`. **Caveat conocido**: el `fullPath` en Twenty apunta a Chatwoot Active Storage — quien haga click necesita estar logged en Chatwoot para verlo. Para v3 si querés ver "en frío", subimos a S3/bucket propio. **Cambios de código**: `src/lib/openai-multimodal.ts` nuevo (wrappers fail-soft de Whisper + vision); `src/lib/attachment-processor.ts` nuevo (orquesta descarga + extracción + arma `enrichedContent` con etiquetas `[audio del cliente]: ...` / `[imagen del cliente]: ...`); `src/lib/twenty.ts` extendido con `createAttachment` y `findOrCreatePersonByPhone`; `src/server/filter.ts` con rule 6 ajustada + helper `hasSupportedMediaAttachment`; `src/server/webhook.ts` con pre-procesamiento entre known-customer y welcome, `effectiveContent` reemplaza `message.content` en welcome/LLM, sync helper `syncProcessedAttachmentsToTwenty` post-LLM (fail-soft, jamás rompe el flow al cliente). **Dep nueva**: `openai@6.36.0` oficial — primera vez que usamos el SDK directo (Mastra sigue manejando el agente; openai SDK solo para Whisper + vision porque Whisper requiere multipart). **Fixtures nuevos**: `09-audio-attachment.json`, `10-image-with-caption.json`, `11-video-only.json`. **Tests**: `tests/lib/attachment-processor.test.ts` nuevo (13 tests: audio OK/too_large/download_failed/whisper_failed, imagen OK/too_large/vision_failed, OTHER no genera placeholder, mixto audio+imagen); 3 tests nuevos en filter.test.ts (audio-only pasa, image+caption pasa, video-only rechazado). Total suite: **153/153 verde**, typecheck limpio. **Sanity end-to-end real contra Twenty**: creé Person + 2 attachments (AUDIO + IMAGE) con `fullPath`, verifiqué linkage por `personId[eq]` filter, borré los 3 — HTTP 200 en cada paso. Pendiente Mariano: smoke con audios e imágenes reales desde WhatsApp. |
| 2026-05-05 | **v2 Sprint 1 — Twenty CRM real**. Reemplazo del mock de `upsert-twenty-lead` por integración real contra Twenty self-hosted. Decisiones del sprint (basadas en exploración previa de la API): (D14) 3 entidades: Person + Company + Opportunity, identificación primaria por phone. (D15) Merge inteligente — campos llenos no se pisan; `lastContactAt` y `messageCount` siempre se actualizan; stage solo avanza nunca retrocede; LOST siempre alcanzable. (D16) Retry 3× con backoff 5s/10s/15s en 5xx y network; 4xx no-retry; si Twenty está caído, lead se loggea y la conversación con el cliente sigue normal. (D17) 6 custom fields creados via metadata API (no 7 como decía el diseño): se reusa `Opportunity.sourceChannel` nativo en lugar de crear `source` custom. **Schema cambios**: stage enum extendido a 8 valores (NEW/CONTACTED/SCREENING/MEETING/PROPOSAL/WON/CUSTOMER/LOST) — SCREENING y CUSTOMER quedan como aliases legacy de CONTACTED y WON. Arquetipo (CALIENTE/A_EXPLORAR/SIN_CLARIDAD/NO_LEAD) y exception (PEDIDO_HUMANO/CONSULTORIA/URGENCIA/RECLAMO/DEMO) en Opportunity; whatsappUrl/firstContactAt/lastContactAt/messageCount en Person. **Hallazgo crítico**: `accountOwnerId` espera el `workspaceMember.id` (no el `User.id` interno). Para Mariano: `44f3a96e-dba6-4bac-8826-166f58bee218`. Pasar el userId genera FK violation 500. **Cambios de código**: `src/lib/twenty.ts` nuevo (cliente HTTP con retry, lookups, mutations, helpers `parsePhoneE164`/`splitName`/`canAdvanceStage`/`aliasStage`). `src/mastra/tools/upsert-twenty-lead.ts` refactor completo — `phone` y `conversationId` ahora vienen via `RequestContext` (no del LLM, evita alucinaciones). `src/lib/nurturing-store.ts` agrega columna `phone` con migración idempotente; `recordInbound` la guarda; el worker LOST usa el phone real para upsertear (skip con warning si row legacy v1 sin phone). `src/server/webhook.ts` extrae `phone` y `name` del sender e inyecta en RequestContext. Backoffice prompt actualizado con nuevos inputs. Env vars: `TWENTY_API_URL`, `TWENTY_API_KEY`, `TWENTY_OWNER_USER_ID`. Tests: `tests/lib/twenty.test.ts` nuevo (17 tests de helpers); `tests/mastra/tools/upsert-twenty-lead.test.ts` reescrito con mocks de twenty.ts (16 tests cubriendo create flow, merge update, stage progression, notes, failures). Total suite: **137/137 verde**, typecheck limpio. Sanity end-to-end real contra Twenty: creé+actualicé+borré Person+Company+Opportunity+Note con todos los custom fields — 8 pasos HTTP 200. Pendiente Mariano: smoke con WhatsApp real desde su teléfono. |

A medida que tomemos decisiones nuevas o cambien las existentes, anotar acá con fecha breve.