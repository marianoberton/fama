# REVISIÓN — Diseño FAMA v1 vs Implementación

**Fecha**: 2026-05-04 (post-cutover)
**Propósito**: Auditar qué del diseño original (`fama-design-v1.md`) se 
cumple en producción, qué se cambió sobre la marcha y por qué, qué 
queda como deuda, y cuáles son los próximos pasos concretos.

---

## Metodología

Recorro las secciones canónicas del diseño y para cada una marco:
- ✅ **Implementado y validado**.
- 🟡 **Implementado parcial** o pendiente de validación.
- ⚠️ **Cambiado sobre la marcha** (con razón).
- ❌ **No implementado** (con razón y prioridad).

---

## Sección 1 — Outcome de negocio + KPIs

**Diseño original**: FAMA captura leads de WhatsApp para FOMO, los 
clasifica, escala los relevantes a humano, registra todos en Twenty CRM.

| Item | Estado | Notas |
|---|---|---|
| Captura de leads en WhatsApp | ✅ | Validado con conversación 8 |
| Clasificación por arquetipo | ✅ | Backoffice clasifica + decide escalar |
| Handoff a humano completo | ✅ | 5 pasos validados en prod |
| Registro en Twenty CRM | 🟡 | Tool `upsert-twenty-lead` está MOCK. Debe conectarse a Twenty real cuando sea momento |

**KPIs medibles definidos**: NO. El diseño no especifica métricas 
concretas. Para producción real necesitamos definir:
- Tasa de captura (leads creados / mensajes entrantes).
- Tasa de escalación correcta (leads escalados que un humano hubiera 
  escalado igual).
- Tiempo de respuesta primera (mensaje cliente → primer reply de FAMA).
- Tasa de handoff exitoso (handoffs sin error técnico).

**Deuda**: definir KPIs concretos + dashboard. Para post-cutover real 
con clientes.

---

## Sección 2 — Target / quién interactúa

**Diseño**: Clientes B2B argentinos buscando soluciones de IA. CEOs, 
CTOs, gerentes de operaciones, etc.

**Implementación**: 
- ✅ Tono y voz alineados.
- ✅ Discovery pide los 4 datos típicos B2B (nombre, empresa, caso, 
  plazo).
- ✅ Probado con tu propia conversación, comportamiento alineado.

**Deuda**: testar con personas externas reales (no vos ni Guille) cuando 
abramos a tráfico amplio.

---

## Sección 3 — Modo / canal

**Diseño**: WhatsApp (vía WhatsApp Business + Chatwoot) como canal único.

**Implementación**: ✅ Validado end-to-end. Chatwoot v4.12.1 → webhook 
agent_bot → FAMA → respuestas de vuelta a WhatsApp.

**Cambio sobre la marcha**: ⚠️ El payload de Chatwoot v4.12.1 tiene 
`messages` dentro de `conversation`, no al root. **Bug crítico que 
descubrimos en cutover y arreglamos** (commit f0579d7).

---

## Sección 4 — Identidad del agente

**Diseño**: Voz de FOMO, profesional cálido, sin marketing-speak, 
respuestas con bullets densos.

**Implementación**: ✅ Knowledge files (identity.md + employees.md + 
services.md) reflejan la voz. Recepcionista responde con bullets, sin 
slogans, alineado.

**Observación**: en Studio el recepcionista respondió con tono levemente 
más informal del diseñado ("¡así puedo ayudarte mejor!"). No es bloqueante 
pero podría ajustarse en instructions si querés tono más serio.

**Deuda**: revisar tono en próximos 5-10 conversaciones reales y ajustar 
instructions si necesario.

---

## Sección 5 — Flujo conversacional

**Diseño**: 
1. Welcome hard-coded condicional.
2. Discovery hasta tener 4 datos.
3. Backoffice clasifica en arquetipo.
4. Si caliente → handoff. Si tibio → respuesta + nurturing. Si frío → 
   se cierra con info.

**Implementación**: 
- ✅ Welcome hard-coded funcionó.
- ✅ Discovery funcionó.
- ✅ Backoffice clasifica + delega correctamente.
- ✅ Handoff a humano funcional.
- 🟡 NURTURING worker corriendo pero NO ejercitado con tráfico real 
  todavía. Validar próxima semana.

---

## Sección 6 — Arquetipos de leads

**Diseño**: 4 arquetipos canónicos.
1. **Caliente**: tiene los 4 datos + plazo corto → escalar.
2. **A explorar**: tiene info pero sin plazo → responder + nurturing.
3. **Sin claridad**: no sabe qué quiere → educar + qualify.
4. **No-lead**: estudiante / curioso / spam → cerrar amable.

**Implementación**: 
- ✅ Backoffice los aplica (validado con conversación de hoy donde 
  detectó "explorando" y pidió más datos).
- 🟡 Falta ejercitar arquetipo "caliente" con caso real (no testeado 
  aún).
- 🟡 Falta ejercitar arquetipo "no-lead" (no testeado aún).

---

## Sección 7 — Excepciones rígidas

**Diseño**: 5 excepciones que sobreescriben la clasificación.
1. **Pedido humano**: "Quiero hablar con alguien" → handoff.
2. **Consultoría compleja**: caso fuera de los 6 empleados → handoff.
3. **Urgencia**: cliente dice "urgente" → handoff con prioridad.
4. **Reclamo**: queja sobre servicio existente → handoff.
5. **Demo completa**: pedido específico de demo → handoff.

**Implementación**:
- ✅ **Pedido humano**: validado en producción y en Studio. Funciona.
- 🟡 **Consultoría compleja**: no testeado.
- 🟡 **Urgencia**: testeado en Studio. Triggerea correctamente.
- 🟡 **Reclamo**: no testeado.
- 🟡 **Demo completa**: no testeado.

**Deuda**: probar manualmente las 4 no-testeadas con prompts específicos 
en Studio.

---

## Sección 8 — Casos de borde

**Diseño**: cubre cliente conocido, mensajes vacíos, audios, etc.

**Implementación**:
- ✅ Filtrado de webhook con 7 reglas (originalmente 6, agregamos regla 
  7 sobre la marcha).
- ✅ Mensajes vacíos → ignorados con razón `empty_content`.
- ✅ Mensajes outgoing del propio bot → ignorados con razón 
  `message_type_not_incoming`.
- ⚠️ **Cliente conocido**: tool `known-customer` falla con 401 cuando 
  el token es agent_bot. **Resuelto** con user token. Pero NO testeado 
  end-to-end (probablemente funciona pero conviene validar).
- ❌ **Audio messages**: el filter no los maneja específicamente. Si 
  Chatwoot manda un message_type=0 con audio attachment, el LLM va a 
  recibir contenido vacío o raro. **Deuda media**: agregar regla de 
  filter o handler específico.

---

## Sección 9 — NURTURING / follow-up

**Diseño**: 
- Ventana 24h Meta (después de 24h sin respuesta del cliente, no se 
  puede mandar mensaje free-form, requiere template).
- Horario laboral configurable.
- Skip si humano ya tomó la conversación.
- Marcar LOST tras N retries.

**Implementación**: 
- ✅ Worker corriendo con `setInterval` 15min.
- ✅ Skip si Chatwoot status es `open` (validado por regla 7).
- ✅ Horario laboral configurable.
- 🟡 **NO ejercitado con tráfico real todavía**. Necesita 2-3 días de 
  uso real para ver si dispara correctamente.

---

## Sección 10 — Knowledge structure

**Diseño**: archivos separados por tema.
- `identity.md` — quiénes somos.
- `employees.md` — los 6 empleados de IA.
- `services.md` — 3 frentes.
- `pricing.md` — 4 planes + setups.
- `faqs.md` — preguntas frecuentes.
- `sales.md` — propuesta de valor.

**Implementación**: 
- ✅ Los 6 archivos existen con contenido real.
- ⚠️ **Issue 3 abierto**: knowledge sobre capacitaciones no aparece 
  cuando se pregunta. El LLM responde "no tengo info específica" cuando 
  pricing.md y faqs.md SÍ la tienen. Probable causa: el LLM no invoca 
  `knowledge-search` o lo invoca con query mala.
- 🟡 **Sin observabilidad** de tool calls del LLM. No podemos ver qué 
  query mandó, si la mandó. Deuda alta.

---

## Sección 11 — Tools + integraciones

**Diseño**: 
- `knowledge-search`: busca en knowledge files.
- `chatwoot-handoff`: 5 pasos para escalar.
- `upsert-twenty-lead`: crea/actualiza lead en Twenty CRM.

**Implementación**:
- ✅ `knowledge-search` existe y se invoca (cuando lo decide el LLM).
- ✅ `chatwoot-handoff` validado en producción con 5 pasos OK.
- 🟡 `upsert-twenty-lead` está **MOCK** (genera leadId fake 
  `mock-<timestamp>`). Para producción real con clientes hay que 
  conectarlo a la API real de Twenty. Deuda alta.

**Cambio sobre la marcha**: ⚠️
- Pasamos `conversationId` y `contactId` por `RequestContext`, no por 
  schema del LLM. **Aprendizaje**: esto debe ser patrón para `phone`, 
  `email`, `name` también.

---

## Sección 12 — Bitácora de decisiones

**Diseño**: D1-D8 documentadas en CLAUDE.md.

**Implementación**:
- ✅ D1 (gpt-4o backoffice).
- ✅ D2 (cliente conocido v1.5).
- ✅ D3 (dedupe webhook).
- ✅ D4 (subdominio fama.fomologic.com).
- ✅ D5 (Traefik via Dockploy).
- ✅ D6 (auth file-based — **cambiada** del plan original que era 
  SimpleAuth).
- ✅ D7 (sin backup configurado — anotado como deuda crítica).
- ✅ D8 (CHATWOOT_PATH_TOKEN coincide).

**Decisiones nuevas que aparecieron sobre la marcha** (deberían 
agregarse a CLAUDE.md):
- D9: Auth Studio = file-based dynamic config Traefik (no SimpleAuth, 
  no labels).
- D10: Modelo handback humano→bot = manual via UI Chatwoot (cambiar 
  status a pending).
- D11: Tipo de token Chatwoot = user token (admin), no agent_bot token.
- D12: Data del request (conversationId, contactId, etc.) = via 
  `RequestContext`, NUNCA schema del LLM.
- D13: Regla 7 del filter = bot solo procesa cuando 
  `conversation.status === 'pending'`.

---

## Cosas que cambiaron significativamente sobre la marcha

### 1. Modelo de auth de Studio (D6 redefinida)

**Original**: SimpleAuth de Mastra con email+password.
**Final**: file-based dynamic config Traefik con basic auth y apr1 
hashes.
**Razón**: SimpleAuth de Mastra resultó ser token-based, no 
email+password. Decidimos no implementar `ICredentialsProvider` custom 
(over-engineering) y movernos a Traefik que es battle-tested.

### 2. Path resolution de Studio (D9 nueva)

**Original**: `MASTRA_STUDIO_PATH=.mastra/output/studio` env var.
**Final**: NO setear esa env var. Default `__dirname/studio` funciona.
**Razón**: el path relativo se resolvía mal en `mastra start` y generaba 
path doble.

### 3. Forma del payload Chatwoot (D9 nueva)

**Original**: Asumimos `body.messages[0]` (formato viejo de Chatwoot).
**Final**: `body.conversation.messages[0]` (Chatwoot v4.12.1) con 
fallback al root.
**Razón**: Chatwoot cambió la estructura del payload entre versiones.

### 4. Type del token Chatwoot (D11 nueva)

**Original**: agent_bot token.
**Final**: user token (admin).
**Razón**: agent_bot tiene scope reducido. No puede crear labels 
(handoff falla en step 1).

### 5. Regla 7 del filter (D13 nueva)

**Original**: 6 reglas en el filter.
**Final**: 7 reglas. La nueva chequea que `conversation.status === 'pending'`.
**Razón**: Chatwoot dispara webhook al agent_bot cuando hay nuevo mensaje, 
sin importar si la conversación está open (humano atendiendo). El bot 
respondía encima del humano. **Bug crítico que NO estaba en el diseño 
original**.

### 6. Modelo handback humano→bot (D10 nueva)

**Original**: NO definido.
**Final**: Modelo A (bot solo procesa pending). Handback manual via UI 
Chatwoot.
**Razón**: emergió como decisión obligatoria al descubrir el bug de 
"bot responde mientras humano atiende". 

### 7. Data del request via RequestContext (D12 nueva)

**Original**: `conversationId` venía en el input schema del LLM.
**Final**: `conversationId` (y `contactId`) van por `RequestContext`. El 
LLM no los ve.
**Razón**: el LLM hallucinaba IDs (típico: 1, 123). En producción real 
hubiera fallado igual.

---

## Cosas del diseño que NO se cumplieron (con razón)

### 1. KPIs medibles

**Por qué no**: el diseño no los definía concretamente y no tuvimos 
tiempo de definirlos. **Cuándo**: post-cutover real con clientes.

### 2. Conexión real a Twenty CRM

**Por qué no**: la tool `upsert-twenty-lead` está MOCK. Decisión 
consciente para v1: probar el flujo end-to-end sin la dependencia de 
Twenty. **Cuándo**: cuando haya clientes reales esperando que aparezcan 
en CRM.

### 3. Detección de cliente conocido

**Por qué solo parcial**: la tool existe pero falló por token de 
agent_bot (sin scope para GET conversations). **Resuelto** con user 
token. **Pendiente**: validar end-to-end. Si funciona → marcar como ✅.

### 4. Tests de los 4 arquetipos no-testeados

**Por qué no**: hicimos cutover priorizando handoff funcional. 
**Cuándo**: próximos 2-3 días con tráfico real.

### 5. Algunas excepciones no testeadas (consultoría compleja, reclamo, 
demo completa)

**Por qué no**: ídem arquetipos. **Cuándo**: en Studio con prompts 
específicos.

### 6. Ack post-handoff con gestión de expectativa

**Por qué no**: el ack actual ("Te paso con un asesor, te respondemos a 
la brevedad") es funcional pero podría mejorarse. **Cuándo**: deuda 
alta para la próxima iteración.

---

## Errores que NO se pueden volver a cometer (clave para el blueprint)

Los 6 errores capitales documentados en `LECCIONES-FAMA.md`. Resumen:

1. **Asumir API de librería sin verificar el código fuente**.
2. **Decir "X funciona" sin mostrar output**.
3. **No detectar transformación de texto del chat**.
4. **Pasar data del request via schema del LLM**.
5. **Skipear smoke local antes de deploy a infra nueva**.
6. **No validar gotchas de Chatwoot antes del cutover**.

Cada uno tiene contramedida explícita en `LECCIONES-FAMA.md`.

---

## Próximos pasos concretos — orden recomendado

### Hoy / mañana (próximas 24h)

1. **Cerrar la conversación 8 en Chatwoot** (o cambiarla a pending si 
   querés que el bot retome). Es la conversación de prueba que dejamos 
   abierta hoy.

2. **Capturar bugs y observaciones** durante 24-48h de uso de FAMA con 
   tu WhatsApp + el de Guille. NO publicar el número externamente.

3. **Rotar credenciales filtradas por chat**: 
   - `OPENAI_API_KEY` (revoke + nueva en OpenAI dashboard).
   - `CHATWOOT_API_TOKEN` (regenerar en Chatwoot UI o Rails console).
   - Actualizar en Dockploy + redeploy.

### Esta semana

1. **Resolver Issue 3 (knowledge sobre capacitaciones)**:
   - Agregar logging de `reply.steps[*].toolCalls` en webhook.ts.
   - Probar en Studio con preguntas sobre capacitaciones.
   - Ajustar instructions del recepcionista si la query del LLM es mala.

2. **Resolver placeholder de phone**:
   - Patrón análogo a `conversationId`: pasar `phone` por 
     `RequestContext` desde el webhook handler.
   - Sacar `phone` del input schema de `upsert-twenty-lead`.

3. **Backup del VPS** configurado.

4. **Validar las 4 excepciones no-testeadas** (consultoría compleja, 
   urgencia, reclamo, demo completa) en Studio.

5. **Validar los 4 arquetipos** con prompts específicos en Studio.

### Próxima semana

1. **Crear `fama-bot@fomo.com.ar`** y migrar el token al user dedicado.

2. **Sesión Fase 1 del blueprint**: extraer patrones reutilizables a 
   `BLUEPRINT.md`. 2-3hs. Output: lista de patrones universales 
   identificados, gotchas técnicos, defaults por decisión D1-D13.

### Próximas 2-3 semanas

1. **Sesión Fase 2 del blueprint**: convertir BLUEPRINT.md en repo 
   template. 2-3hs.

2. **Decidir agente #2**: clon de fomo-core viejo o cliente nuevo. 
   Esa migración valida el blueprint.

3. **Conectar `upsert-twenty-lead` a Twenty real** (sacar el mock).

---

## Métrica de éxito de FAMA v1

Criterios para considerar v1 "exitoso" antes de pasar al agente #2:

- [ ] FAMA opera 7 días sin caídas.
- [ ] 0 mensajes del bot encima de humano (validar con regla 7).
- [ ] 0 leads creados con phone fake en CRM (después del fix).
- [ ] Knowledge responde correctamente al menos 80% de preguntas 
      cubiertas en archivos.
- [ ] 4 arquetipos validados con tráfico real.
- [ ] 5 excepciones validadas con tráfico real.
- [ ] NURTURING dispara correctamente al menos 1 vez.
- [ ] Backup del VPS configurado y testeado (snapshot manual exitoso).

Cuando todos los criterios estén ✅, FAMA v1 es validado y arrancamos 
el blueprint con datos reales.

---

## Cierre

FAMA v1 está en producción, con bugs conocidos pero documentados. La 
mayoría son ajustes, no problemas estructurales. El sistema base 
funciona end-to-end.

**Próxima sesión**: 24-48h de uso real → rotar credenciales → resolver 
Issue 3 + phone placeholder → empezar blueprint.