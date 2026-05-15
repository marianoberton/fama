# LECCIONES — FAMA v1 (cutover 2026-05-04)

Aprendizajes capturados durante el desarrollo y deploy de FAMA. Este 
archivo es input directo para `BLUEPRINT.md` cuando lo armemos en Fase 1.

---

## Estado al cierre

**FAMA está en producción**. Validado end-to-end:
- Webhook real de Chatwoot → FAMA procesa correctamente.
- Recepcionista responde con knowledge.
- Backoffice clasifica y delega.
- Handoff completo de 5 pasos funcional (ack + label + nota privada + asignación + status).
- Regla 7 (silencio cuando humano atiende) funciona.

**Sin clientes reales todavía**. El número `+5491172343506` está activo 
pero no publicado externamente.

---

## Errores que NO se pueden volver a cometer

Estos son los errores caros de hoy. Cada uno tiene su contramedida 
explícita. Van directo al skill de Claude Code y al checklist de senior 
architect.

### 1. Asumir API de librería sin verificar el código fuente

**Qué pasó**: 
- Asumí que `SimpleAuth` de Mastra hacía email+password. Era token-based. 
  30 min perdidos antes de descartar el approach.
- Asumí que `MASTRA_STUDIO_PATH=.mastra/output/studio` funcionaba con 
  cualquier cwd. El path se resolvía relativo al spawn cwd, generaba 
  path doble. ~1h perdida.
- Asumí que `runtimeContext` era el nombre de la API. Era `RequestContext` 
  (renombrada en Mastra 1.31). Claude Code lo detectó al verificar.

**Contramedida**: 
> Antes de tomar una decisión arquitectónica que dependa de comportamiento 
> de una librería, **verificar la API real desde `node_modules` o el 
> código fuente**, no desde la doc oficial. La doc miente o está vieja 
> con frecuencia.

### 2. Decir "X funciona" sin mostrar output que lo demuestre

**Qué pasó**:
- Reporté "smoke local OK" sin haber abierto el browser. El server había 
  fallado con env vars faltantes.
- Reporté "archivo creado en VPS" sin haberlo guardado realmente. 5 
  iteraciones perdidas.

**Contramedida**:
> Operativamente: nunca afirmar "funciona" sin mostrar output (logs, 
> `cat`, `docker ps`, screenshot del browser). El "OK" sin evidencia es 
> el equivalente operativo de mentir, aunque no sea intencional.

### 3. No detectar transformación de texto en el chat

**Qué pasó**: El cliente de chat de Claude.ai transformaba 
`fama.fomologic.com` en `[fama.fomologic.com](http://fama.fomologic.com)` 
al copiar. Tomó **6 iteraciones** detectarlo. Cuando el chat te muestra 
algo y te llega transformado al portapapeles, ningún copy-paste va a 
funcionar.

**Contramedida**:
> Si un procedimiento trivial (copy-paste, edición de archivo) falla 
> 2 veces consecutivas con el mismo síntoma, **pedir screenshot directo** 
> al humano. No insistir con el mismo método. Las transformaciones de 
> chat/clipboard son invisibles desde el feedback textual.

### 4. Pasar data del request via schema del LLM

**Qué pasó**: `chatwoot-handoff` esperaba `conversationId` en su input. 
El LLM lo inventaba (típico: 1, 123, números chicos). En Studio causaba 
404. En producción real fallaría igual.

`upsert-twenty-lead` mismo bug con `phone`. Lead se creaba con 
`phone: "<número del cliente>"` literal.

**Contramedida**:
> **Toda data que viene del request (conversationId, contactId, phone, 
> email del usuario, accountId) se pasa por `RequestContext` (nombre en 
> Mastra 1.31), NUNCA por schema del LLM**. El LLM no debe ser 
> responsable de copiar identificadores.

### 5. Skipear smoke local con consecuencias

**Qué pasó**: Skippeé smoke local antes del primer deploy al VPS. El 
build tenía bug del `MASTRA_STUDIO_PATH` que se hubiera detectado en 
local en 5 minutos. En el VPS tomó 1h debuguear porque hay que ir a 
ciegas con `docker exec`.

**Contramedida**:
> **El smoke local es no-negociable** antes de deploy a infra nueva. 
> "Trust me, anda" no es respuesta válida. 5 min en local ahorran 1-2h 
> en remoto.

### 6. No verificar gotchas de Chatwoot antes de cutover

**Qué pasó**: Después del cutover, FAMA no recibía webhooks. Tomó 30 min 
descubrir que:
- Chatwoot solo dispara webhook a agent_bot cuando status es `pending`.
- El payload de Chatwoot v4.12.1 tiene `messages` dentro de `conversation`, 
  no al root.
- El `CHATWOOT_API_TOKEN` de tipo agent_bot tiene scope reducido y no 
  puede crear labels.

**Contramedida**:
> Antes de cutover, **validar con un payload real de Chatwoot** que el 
> filter pasa. Chatwoot tiene comportamientos no documentados (como el 
> filtrado por status) que solo aparecen con tráfico real. Capturar un 
> payload real con `docker logs sidekiq | grep AgentBots::WebhookJob` 
> y testear localmente.

---

## Aprendizajes técnicos universales (van al BLUEPRINT)

### Mastra

1. **`mastra build --studio`** + **NO setear `MASTRA_STUDIO_PATH`** = 
   default funciona. El path relativo provoca path doble.

2. **`RequestContext`** es la API correcta para data del request 
   (renombrada desde `RuntimeContext` en 1.31). Importa desde 
   `@mastra/core/di`.

3. **`mastra start`** internamente lanza `node .mastra/output/index.mjs` 
   con cwd=`/app/.mastra/output`. Importa para path resolution.

4. **`agents:` nativo de Mastra** funciona como "agentes como tools" 
   sin escribir glue manual (recepcionista→backoffice via patrón nativo).

### Chatwoot

1. **Status `pending` es la única condición** para que Chatwoot 
   dispare webhook a un AgentBot. Status `open`/`resolved`/`snoozed` 
   no dispara.

2. **El payload de v4.12.1** tiene `messages` dentro de `conversation`, 
   no al root. El filter del bot debe leer `body.conversation.messages[0]`.

3. **`agent_bot` tokens** tienen scope reducido. Solo permiten POST 
   `messages`. Para labels, status, asignaciones se necesita 
   **`user` token** (admin user).

4. **Handback humano→bot es manual**: agente cambia status de `open` 
   a `pending` desde el dropdown del header. Próximo mensaje → bot 
   procesa.

5. **No hay automation rule** en Chatwoot v4.12.1 para auto-handback 
   por inactividad. Si se quiere, requiere worker dedicado.

### Dockploy

1. **`dokploy-network`** es la red overlay/swarm correcta para que 
   Traefik enrute al container.

2. **NO usar labels Traefik en compose** — issue #484 los strippea. 
   Usar **file-based dynamic config** en 
   `/etc/dokploy/traefik/dynamic/<agent>.yml`.

3. **Basic auth Traefik** se configura via apr1 hashes en el dynamic 
   config, NO via SimpleAuth en código.

4. **Webhook excluido de basic auth** via `!PathPrefix(\`/v1/webhooks\`)` 
   en la rule del router.

5. **`passHostHeader: true`** en el service de Traefik para que el 
   container reciba el Host header original.

### Operativos

1. **Verificar que el commit que se deploya es el que esperás**. 
   Dockploy puede hacer pull pero servir de cache vieja. Verificar con 
   `cat docker-compose.yml` en `/etc/dokploy/compose/<proyecto>/code/`.

2. **Container "Created" en docker-ps -a** sin logs → mismatch de red 
   o env vars faltantes. `docker rm` el zombie antes de redeploy.

3. **Cuando el chat transforma texto** (markdown links): la única 
   solución 100% segura es tipear a mano en el VPS. `tee << 'EOF'` 
   también funciona si lo escribís a mano vos.

---

## Decisiones de producto que no estaban en el design original

Estas decisiones se tomaron sobre la marcha y deberían haber estado 
en el design doc desde el inicio. Van al checklist del AI engineer 
review en el blueprint.

### 1. Modelo de handback humano→bot

**No definido en design original**. Surgió como bug crítico (FAMA 
respondía mientras vos contestabas como humano).

**Resolución**: Modelo A (bot solo procesa pending). Handback manual 
via UI de Chatwoot (cambiar status a pending). Documentado en CLAUDE.md.

**Para blueprint**: sección obligatoria en design doc — *"¿Qué hace el 
bot cuando humano atiende? ¿Cómo se hace handback?"*

### 2. Tipo de token de Chatwoot

**No definido**. Asumimos `agent_bot` token. No alcanza para handoff.

**Resolución**: user token (admin). Anotado como deuda crítica rotar 
post-cutover real.

**Para blueprint**: especificar **explícitamente** el tipo de token 
necesario en setup, con razón.

### 3. Auth de Studio en producción

**Decidido tarde**. Pasamos por SimpleAuth (no funcionaba), 
`ICredentialsProvider` custom (over-engineering), Traefik labels 
(issue #484), file-based dynamic config (✓).

**Resolución**: file-based en `/etc/dokploy/traefik/dynamic/`.

**Para blueprint**: **patrón canónico documentado**: file-based dynamic 
config con basic auth + path exclusion para webhook. Cero código de 
auth en el repo.

### 4. Ack post-handoff (mensaje al cliente)

**Definido en design**: "Te paso con un asesor, te respondemos a la 
brevedad."

**Observación en producción**: el cliente puede sentir ansiedad si pasa 
tiempo sin respuesta humana. Se considera mejorar el ack con texto tipo: 
*"Te paso con un asesor. Si tenés algo más para decir, escribilo y lo 
leemos en cuanto tomemos la conversación."*

**Para blueprint**: ack post-handoff debería gestionar expectativa de 
timing.

---

## Cosas que SÍ funcionaron bien (para preservar en blueprint)

1. **Patrón Recepcionista + Backoffice**. Voz única visible al cliente. 
   Backoffice como "cerebro silencioso" para clasificación y handoff. 
   Mostró comportamiento correcto en discovery + escalación.

2. **5 excepciones rígidas** + **4 arquetipos**. Detección de "pedido 
   humano" funcionó al primer mensaje. Discovery de los 4 datos también.

3. **Welcome hard-coded condicional** (mensaje <N palabras). Evitó 
   saludo genérico del LLM en primer turno.

4. **Knowledge files separados por tema** (pricing, faqs, sales, 
   services, identity, employees). El recepcionista respondió bien 
   con info de servicios.

5. **Dedupe de message_id** con TTL 5min funcionó silenciosamente. 
   Cero duplicados procesados.

6. **NURTURING worker** corriendo (no se ejercitó hoy con tráfico real, 
   pero arrancó bien y respeta horario laboral).

7. **Tests** (100/100 al cierre). El cubrimiento ayudó a no romper nada 
   en los 3 fixes críticos del día.

8. **Chatwoot Studio** integrado al server permitió debuggear handoff 
   antes de cutover real. Detectó el bug del `conversationId` 
   hallucinado. El issue 3 (knowledge incompleto) también lo detectó 
   Studio.

9. **`fama.yml` Traefik file-based** sigue las convenciones del 
   `fomo-core.yml` que ya funcionaba (passHostHeader, certResolver 
   letsencrypt, redirect-to-https). Reusar patrones probados >> 
   inventar nuevos.

---

## Deudas pendientes — clasificadas por urgencia

### 🔴 Críticas (resolver dentro de 1 semana)

- [ ] **Backup del VPS**. Sin backup, mastra.db se puede perder. 
  Snapshot del provider (USD 2-5/mes) o restic con cron.

- [ ] **Rotar `OPENAI_API_KEY`**. Pasó por chat hoy.

- [ ] **Rotar `CHATWOOT_API_TOKEN`** del user `mariano@`. Es admin 
  con scope total a la cuenta. Si filtra, expone toda la operación 
  de Chatwoot.

- [ ] **Crear user dedicado `fama-bot@fomo.com.ar`** en Chatwoot 
  para el bot (en lugar de usar el user de Mariano personal). 
  Generar token específico, rotar en compose.

- [ ] **Rotar token agent_bot 2** (el viejo). Ya filtró por chat 
  aunque tenga scope reducido.

### 🟡 Altas (resolver dentro de 2-3 semanas)

- [ ] **Issue 3: knowledge incompleta sobre capacitaciones**. 
  Faltan logs de tool calls del LLM para diagnosticar por qué no 
  invoca `knowledge-search` o por qué la query no matchea. 
  Agregar `logger.info` con `reply.steps[*].toolCalls` y 
  `toolResults` en webhook.ts:225-234.

- [ ] **Lead con placeholder `phone: "<número del cliente>"`**. 
  Mismo patrón que conversationId: pasar `phone` por 
  `RequestContext` desde el webhook handler hacia 
  `upsert-twenty-lead`. El LLM no debería tocar `phone`.

- [ ] **`stage: MEETING` para handoff "quiero hablar con humano"** 
  es discutible. Quizás `CONTACTED` o `NEW` es más apropiado. 
  Decisión de prompt para el backoffice.

- [ ] **Mejorar ack post-handoff** con gestión de expectativa: 
  *"Te paso con un asesor. Si tenés más para decir, escribilo y 
  lo leemos en cuanto tomemos la conversación."*

### 🟢 Medias (resolver en 1-3 meses)

- [ ] **Política de privacidad y manejo de datos**. Para clientes 
  B2B con Compliance Officer.

- [ ] **Casos de éxito documentados** para `sales.md`. Hoy solo 
  Market Paper.

- [ ] **Eventos `conversation_*` sin `account` field generan 401 
  ruido en logs Chatwoot**. Hacer el filter más permisivo con 
  eventos que no son `message_created`.

- [ ] **Tracing/observability**: Langfuse o OpenTelemetry para 
  poder ver flujos completos.

- [ ] **Eval set sistemático** con casos canónicos (los 4 arquetipos 
  + 5 excepciones + casos borde).

### 🔵 Bajas (resolver oportunisticamente)

- [ ] Tests del NURTURING worker no inspeccionan body POST.
- [ ] Circuit breaker en llamadas Chatwoot/OpenAI.
- [ ] Graceful shutdown del NURTURING worker.
- [ ] Validación Zod del payload Chatwoot al entrar.
- [ ] Fallback cuando OpenAI down (mensaje fijo + escalar humano).
- [ ] Auto-handback worker (Modelo C) cuando humano sin actividad 
  por N min.
- [ ] Ruido de `hembra.com.ar` en logs ACME (side-quest).
- [ ] `chatwoot-handback` como tool programática para casos donde 
  el bot decida retomar autónomamente.

---

## Próximos pasos

### Inmediato (próximas 24-48h)

1. **Operar FAMA con tráfico real** (vos + Guille mandando WhatsApp). 
   Capturar bugs y observaciones que solo aparecen con uso.

2. **Resolver Issue 3 (knowledge incompleto)**. Probable fix: agregar 
   logging de tool calls + ajustar instructions del recepcionista 
   para que use `knowledge-search` más agresivamente.

3. **Resolver placeholder de phone**. Patrón análogo al fix de 
   `conversationId` via RequestContext.

4. **Rotar credenciales filtradas por chat** (OPENAI_API_KEY, 
   CHATWOOT_API_TOKEN).

### Semana que viene

1. **Backup del VPS** configurado.

2. **Crear `fama-bot@fomo.com.ar`** y migrar token.

3. **Sesión Fase 1 del blueprint**: extraer patrones de FAMA a 
   `BLUEPRINT.md`. 2-3hs.

### Próximas 2-3 semanas

1. **Sesión Fase 2 del blueprint**: convertir BLUEPRINT.md en repo 
   template `mastra-customer-support-template/`. 2-3hs.

2. **Skill de Claude Code** `customer-support-b2b-mastra/` con 
   reglas operativas.

3. **Decidir agente #2**: clon de fomo-core viejo, o cliente nuevo. 
   Esa migración valida el blueprint.

---

## Observaciones meta

### Tiempo total real de FAMA v1

Aproximadamente **30-40 horas** distribuidas en varias jornadas. 
Auditoría:
- 75% tiempo evitable (asunciones sin verificar, errores operativos, 
  decisiones de infra arbitradas tarde, bugs de diseño no detectados).
- 25% trabajo legítimo del dominio (knowledge content, prompts, 
  decisiones de producto).

**El blueprint debería reducir el 75% evitable. Meta agente #2: <40% 
del tiempo de FAMA**.

### Lección operativa global

> Para construir cosas bien con LLMs como pair, **la inversión en 
> verificación previa siempre paga**. Los 10 minutos de "antes de hacer 
> X, verificar Y" siempre son menos que los 60 minutos de "X falló, 
> debugueamos en producción".

Esto vale para nosotros (Claude.ai sesión + Claude Code sesión + vos) 
y vale para el blueprint que armemos.