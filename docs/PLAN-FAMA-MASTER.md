# PLAN MAESTRO — FAMA

**Fecha**: 2026-05-12  
**Estado actual**: v2 (Sprints 1-3) implementado, 201 tests verdes. En producción desde 2026-05-04.

Este documento consolida todo el trabajo pendiente de CLAUDE.md, REVISION-FAMA-V1.md y LECCIONES-FAMA.md en un solo lugar con prioridades y responsables claros. Es el documento de referencia para saber qué sigue.

---

## Estado de lo implementado

| Componente | Estado | Notas |
|---|---|---|
| Webhook handler + 7 reglas de filtrado | ✅ | En producción |
| Recepcionista (gpt-4o-mini) | ✅ | En producción |
| Backoffice (gpt-4o) | ✅ | En producción |
| Agendador (gpt-4o-mini) | ✅ | Implementado, pendiente smoke |
| `knowledge-search` | ✅ | 6 archivos md con contenido real |
| `chatwoot-handoff` (5 pasos) | ✅ | Validado en producción |
| `upsert-twenty-lead` (Twenty real) | ✅ | Sprint 1, pendiente smoke |
| `list-calendar-slots` | ✅ | Sprint 3, pendiente smoke |
| `book-calendar-event` | ✅ | Sprint 3, pendiente smoke |
| Multimodalidad (Whisper + vision) | ✅ | Sprint 2, pendiente smoke |
| NURTURING worker | ✅ | Corriendo, no ejercitado con tráfico real |
| Dedup de message_id (TTL 5min) | ✅ | En producción |
| Google Calendar + DWD | ✅ | Setup operacional hecho 2026-05-07 |
| Twenty CRM (Person/Company/Opportunity) | ✅ | 6 custom fields creados |
| Docker + VPS + Traefik | ✅ | En producción |

---

## Bloque 1 — Urgente: seguridad operacional

> Mariano tiene que hacer esto. No hay código aquí.

### 1.1 Rotar credenciales filtradas por chat

Las siguientes credenciales circularon en el chat de Claude.ai y deben rotarse **ya**:

- **`OPENAI_API_KEY`**: revoke + nueva en platform.openai.com → pegar en Dockploy → redeploy.
- **`CHATWOOT_API_TOKEN`** del user `mariano@`: regenerar en Chatwoot UI (Admin → Profile) o Rails console → pegar en Dockploy → redeploy.
- **Token agent_bot 2** (viejo, scope reducido): Settings → Agent Bots → regenerar igual.

**Por qué es urgente**: el CHATWOOT_API_TOKEN es admin con scope total a toda la cuenta. Si alguien lo toma, puede leer y escribir toda la operación de FOMO.

### 1.2 Crear user dedicado `fama-bot@fomo.com.ar`

- Crear user en Chatwoot con rol `agent`.
- Generar API token para ese user.
- Reemplazar el token de `mariano@` en Dockploy + redeploy.
- Luego revocar el token de `mariano@` que se usó hasta ahora.

**Por qué**: hoy el bot opera con las credenciales personales de Mariano. Si el token filtra, expone toda la cuenta, no solo el bot.

### 1.3 Backup del VPS

`mastra.db` es la única fuente de verdad de memoria de conversaciones y nurturing. Hoy no tiene backup.

Opciones (elegir una):
- **Snapshot del provider** (más simple): activar snapshots diarios automáticos en el panel del VPS (~USD 2-5/mes).
- **Restic con cron** (más robusto): instalar restic en VPS, bucket S3/Backblaze, cron diario. ~30min de setup.

---

## Bloque 2 — Esta semana: validar v2

Los Sprints 1-3 de v2 están implementados pero ninguno fue validado con tráfico WhatsApp real. Esto es lo que falta.

### 2.1 Smoke Twenty CRM (Sprint 1)

Mandarte 1-2 mensajes desde tu WhatsApp personal al número de FAMO. Verificar en Twenty UI:

- [ ] Person creado con `phones.primaryPhoneNumber`, `whatsappUrl` clickeable a Chatwoot, `firstContactAt`, `lastContactAt`, `messageCount`.
- [ ] Opportunity creada con `stage`, `sourceChannel=WHATSAPP`.
- [ ] Si pediste hablar con humano: `exception=PEDIDO_HUMANO`, Note adjunta con el resumen estructurado.
- [ ] Si pasaste empresa: Company creada con `accountOwnerId` correcto.

Si algo no aparece, revisar logs del container: `docker logs fama-container-name --tail=50`.

### 2.2 Confirmar email de Guille (Sprint 3 — Calendar)

`guille@fomo.com.ar` retorna `notFound` en freebusy. Hay que confirmar el email correcto del calendar de Guille en el Workspace y actualizar:

```
CALENDAR_IDS_TO_CHECK=mariano@fomo.com.ar,<email-real-de-guille>
```

Mientras tanto el agendador funciona solo contra el calendar de Mariano.

### 2.3 Smoke Multimodalidad (Sprint 2)

Tres pruebas desde WhatsApp:

1. **Audio**: mandarte un audio diciendo algo concreto. FAMA debe responder coherentemente con la transcripción. En Twenty: attachment AUDIO adjunto con `fullPath`.
2. **Imagen**: mandarte una foto de algo. FAMA describe. En Twenty: attachment IMAGE adjunto.
3. **Video**: mandarte un video corto. FAMA debe NO responder (filter rule 6 rechaza video-only).

En logs: `webhook: attachments processed` con `mediaCount: N`, `hasMedia: true`.

### 2.4 Smoke Calendar Agent (Sprint 3)

Secuencia desde WhatsApp:

1. Mandarte "necesito una demo".
2. Backoffice hace discovery. Cuando tiene Nivel 2, delega al agendador.
3. Agendador pide email. Dar uno real.
4. Agendador ofrece 2 slots reales libres.
5. Elegir uno.

Verificar:
- [ ] **Calendar**: evento creado con Meet link auto-generado. Guille como invitada (si el email está ok).
- [ ] **Mail**: llega invitación de Calendar con el Meet link.
- [ ] **Twenty**: Opportunity con `stage=MEETING`, `arquetipo=CALIENTE`, Note con detalle del evento.
- [ ] **Chatwoot**: nota privada con fecha + hora + frente + link Meet. Label `venta-{frente}`. Status sigue **pending** (no open).
- [ ] **Logs**: `book-calendar-event: Calendar event created`, sin ERRORs en sync.

---

## Bloque 3 — Esta semana: validar comportamiento conversacional

Estos no son smokes de integración sino validaciones de comportamiento del LLM.

### 3.1 Validar los 4 arquetipos en Studio

Abrir `http://localhost:4111` (o la URL del VPS con basic auth) y probar:

| Arquetipo | Prompt de prueba | Expected |
|---|---|---|
| 1 — Caliente | "Soy dueño de una fábrica de 80 empleados, necesito automatizar el área de cobranzas, tenemos budget y queremos arrancar este mes" | Escala a humano, label `venta-agentes`, nota privada con datos |
| 2 — A explorar | "Estoy viendo opciones de IA para mi empresa, somos 15, no tengo urgencia" | NO escala, responde con info + invitación a demo |
| 3 — Sin claridad | "Qué hacen ustedes" | FAMA pregunta para clarificar, no escala |
| 4 — No-lead | "Soy estudiante haciendo una tesis sobre IA en empresas" | Cierre cordial, deriva a hola@fomologic.com |

### 3.2 Validar las 5 excepciones en Studio

| Excepción | Prompt de prueba | Expected |
|---|---|---|
| 1 — Pedido humano | "Necesito hablar con alguien del equipo" | `escalar-humano`, ack inmediato |
| 2 — Consultoría | "Necesitamos un diagnóstico estratégico de nuestros procesos" | `venta-consultoria`, stage MEETING |
| 3 — Urgencia | "Urgente, tengo una reunión de directorio mañana y necesito una propuesta" | label `urgencia`, nota con "URGENTE —" al inicio |
| 4 — Reclamo | "Estamos teniendo problemas con el agente que compramos, no funciona como prometieron" | `reclamo`, nota con últimos mensajes del cliente |
| 5 — Demo (completa) | Con Nivel 2 completo: "¿Podemos agendar una demo?" | Delega a agendador si Calendar configurado |

### 3.3 Issue 3 — Knowledge de capacitaciones

**Síntoma**: el LLM responde "no tengo info específica" cuando se pregunta sobre capacitaciones, aunque `pricing.md` y `faqs.md` la tienen.

**Fix necesario** (código): agregar logging de tool calls en `src/server/webhook.ts` para ver si el LLM llama a `knowledge-search` y con qué query.

```typescript
// En webhook.ts, después de reply = await recepcionista.generate(...)
const toolCalls = reply.steps?.flatMap(s => s.toolCalls ?? []) ?? [];
logger.info({ toolCalls }, 'webhook: tool calls del LLM');
```

Después de agregar el log: probar en Studio con "¿qué incluye el plan Starter?" y ver en logs qué query mandó. Si no mandó ninguna, ajustar instructions del recepcionista para que llame más agresivamente.

---

## Bloque 4 — Esta semana: deudas técnicas de alta prioridad

### 4.1 Mejorar ack post-handoff

El ack actual es funcional pero no gestiona expectativa de timing. El cliente puede sentir ansiedad si nadie le responde enseguida.

**Cambio en instructions del Backoffice**: cuando llama a `chatwoot-handoff`, el `ackMessage` debe incluir:

> "Te paso con un asesor del equipo de FOMO. Si tenés algo más para agregar, escribilo acá y lo leemos en cuanto tomemos la conversación."

Esto ya está en manos del prompt, no requiere cambio de código.

### 4.2 Validar NURTURING con tráfico real

El worker está corriendo pero nunca disparó en producción (el tráfico ha sido solo de prueba). Para validarlo:

1. Dejar una conversación sin responder por 4+ horas en horario laboral AR (9-19 UTC-3).
2. Verificar en logs del container que el worker intenta el reintento.
3. Verificar que el mensaje llega al WhatsApp del cliente.
4. Verificar que la conversación no estaba en status `open` (si estaba, el worker tiene que skipearla — eso también hay que validar).

---

## Bloque 5 — Próximas 2-3 semanas: infraestructura y observabilidad

### 5.1 Tracing de tool calls (observabilidad)

Hoy no hay visibilidad de qué hacen los agentes en producción. El logging del bloque 3.3 es el primer paso; la versión más completa es integrar Langfuse o al menos loguear estructuradamente todos los `toolCalls` y `toolResults` de cada reply.

**Alcance mínimo útil**: un log por cada tool call con `{tool, input, output, durationMs, conversationId}`. Con eso podés ver en producción si el LLM está usando bien las tools.

### 5.2 Política de privacidad y manejo de datos

Para clientes B2B con Compliance Officer. FAMA procesa nombres, emails, números de teléfono, y los guarda en Twenty. Hay que tener claro qué se guarda, dónde, por cuánto tiempo, y qué se puede pedir que se borre.

Mínimo para cubrir: mencionar en el primer mensaje que la conversación puede ser procesada por IA y los datos guardados para seguimiento comercial.

### 5.3 Criterios de éxito de v1 — cerrar el checklist

Del REVISION-FAMA-V1.md, FAMA v1 es "exitoso" cuando:

- [ ] FAMA opera 7 días sin caídas.
- [ ] 0 mensajes del bot encima de humano (validar con Bloque 3).
- [ ] 0 leads con phone fake en CRM (ya arreglado en Sprint 1 con RequestContext).
- [ ] Knowledge responde correctamente al menos 80% de preguntas cubiertas.
- [ ] 4 arquetipos validados con tráfico real.
- [ ] 5 excepciones validadas con tráfico real.
- [ ] NURTURING dispara correctamente al menos 1 vez.
- [ ] Backup del VPS configurado y testeado.

---

## Bloque 6 — Próximas 2-3 semanas: blueprint para agente #2

Una vez que los criterios de éxito del bloque 5.3 estén todos ✅, arrancar la sesión de blueprint.

### 6.1 Sesión Fase 1 del blueprint (2-3hs)

Extraer patrones reutilizables de FAMA a `BLUEPRINT.md`. Output esperado:
- Lista de patrones universales identificados (webhook filter, Recepcionista+Backoffice, handoff, nurturing).
- Gotchas técnicos documentados (los 6 de LECCIONES-FAMA.md + nuevos).
- Defaults canónicos para las decisiones D1-D13.

### 6.2 Sesión Fase 2 del blueprint (2-3hs)

Convertir `BLUEPRINT.md` en repo template `mastra-customer-support-template/`. Output:
- Scaffold listo con las piezas genéricas ya resueltas.
- Variables a completar claramente marcadas.
- Checklist de validación pre-cutover.

### 6.3 Decidir agente #2

Candidatos más probables:
- **Mateo (cobranzas)**: si aparece primer cliente con esa necesidad.
- **Lucas (ventas)**: si FOMO quiere el mismo sistema para otro negocio propio.

La migración del agente #2 es el test real del blueprint. Meta de tiempo: 3-5 días vs los ~7 de FAMA.

---

## Bloque 7 — Backlog v3+ (no priorizado, para cuando llegue el momento)

Cosas que tienen valor pero no tienen urgencia hoy:

| Item | Tipo |
|---|---|
| Templates Meta para NURTURING >24hs | Feature |
| Auto-handback worker (humano inactivo N min → bot retoma) | Feature |
| Eval set sistemático (4 arquetipos + 5 excepciones como tests de regresión) | Testing |
| KPIs y dashboard (tasa captura, tasa escalación, tiempo respuesta) | Observabilidad |
| Circuit breaker en llamadas Chatwoot / OpenAI | Resiliencia |
| Fallback cuando OpenAI down (texto fijo + escalar humano) | Resiliencia |
| Debouncing de mensajes seguidos del mismo cliente | UX |
| Política "no-bot" (label para silenciar FAMA en conversación específica) | Operativo |
| Inferencia de timezone del cliente | UX |
| Casos de éxito reales en `sales.md` | Contenido |
| Graceful shutdown del NURTURING worker | Operativo |
| Ruido de `hembra.com.ar` en logs ACME | Limpieza |

---

## Resumen ejecutivo — orden de ataque

```
Semana 1:
  Día 1-2:  Bloque 1 (rotar credenciales, user dedicado, backup) — Mariano
  Día 2-3:  Bloque 2 (smokes de integración v2) — Mariano
  Día 3-5:  Bloque 3 (validación conversacional en Studio) — Mariano + Guille
             Bloque 4 (ack mejorado, NURTURING) — Mariano

Semana 2:
  Día 6-8:  Bloque 5 (observabilidad, criterios de éxito)
  Día 8-10: Si criterios de éxito ✅ → Bloque 6 arrancar blueprint

Semana 3-4:
  Bloque 6 completo → repo template listo → agente #2
```

---

## Quién hace qué

| Tarea | Responsable |
|---|---|
| Rotar credenciales | Mariano |
| Crear fama-bot@fomo.com.ar | Mariano |
| Configurar backup VPS | Mariano |
| Confirmar email Guille | Mariano |
| Smokes de integración (WhatsApp real) | Mariano |
| Validación arquetipos/excepciones en Studio | Mariano + Guille |
| Fix logging tool calls (Issue 3) | Claude Code |
| Ajuste ack post-handoff en prompt | Claude Code |
| Blueprint BLUEPRINT.md | Sesión conjunta |
| Repo template agente #2 | Claude Code |
