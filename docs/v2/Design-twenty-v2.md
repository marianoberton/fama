# DESIGN — Twenty CRM Integration (FAMA v2 — Sprint 1)

**Fecha**: 2026-05-04
**Owner**: Mariano Berton
**Estado**: Diseño cerrado. Listo para implementar.
**Estimación**: 1 día con tests.

---

## 1. Outcome esperado

Cuando un cliente manda mensaje a FAMA por WhatsApp, FAMA:

1. **Crea o actualiza** un Person + Company (si aplica) + Opportunity en Twenty CRM, identificando por phone.
2. Mantiene el lead **actualizado** en cada turno (last_contact_at, message_count, stage, notas, etc.).
3. Cuando hay handoff, **registra una Activity/Note** con resumen de la conversación dentro del Person.
4. Asigna como **owner: Mariano** por default.

Vos podés ver toda la información del lead en Twenty UI sin tener que ir a Chatwoot.

---

## 2. Setup técnico

### 2.1 Twenty self-hosted

- URL: la del Twenty self-hosted de Mariano (definir en env var `TWENTY_API_URL`).
- API key: definir en env var `TWENTY_API_KEY`.

Antes de codear, **Claude Code debe explorar la API de Twenty self-hosted** y confirmar:
- Endpoints exactos para Person, Company, Opportunity, Note/Activity.
- Formato de autenticación (Bearer token, header custom, etc.).
- Si soporta GraphQL o REST (Twenty usa GraphQL por default, pero hay REST endpoints).
- Cómo se manejan los "custom fields" (los 6 que vamos a agregar).
- Si los custom fields requieren ser creados en la UI primero o vía API.

**Tarea pre-implementación**: 10-15 min de exploración. Reporte de qué API se usa, ejemplos de request, formato de errores.

### 2.2 Mock data existente

- Los leads mock que tiene Mariano en Twenty se dejan. Los borra a mano cuando quiera.
- FAMA NO va a tocarlos porque no comparten phone con leads reales.

### 2.3 Owner default

- Todos los Person + Opportunity creados por FAMA tienen owner = Mariano.
- Identificar el `userId` de Mariano en Twenty antes de empezar (env var `TWENTY_OWNER_USER_ID`).

---

## 3. Modelo de datos

### 3.1 Tres entidades

```
Person (contacto individual)
  ├── identifica por: phoneNumber (primary), email (secondary)
  ├── relacionado con: Company (si la mencionó)
  └── tiene: Opportunity asociada

Company (empresa)
  ├── identifica por: nombre
  └── tiene: muchos Person

Opportunity (deal)
  ├── identifica por: link al Person
  ├── tiene: stage (NEW → CONTACTED → MEETING → PROPOSAL → WON → LOST)
  └── tiene: notas, source, arquetipo, exception
```

### 3.2 Campos en Person

**Estándar de Twenty**:
- `name` (firstName + lastName) — del WhatsApp profile o "Anónimo".
- `phones` — del webhook Chatwoot (E.164, ej. +5491132766709).
- `emails` — solo si el cliente lo mencionó.
- `companyId` — link a Company si aplica.

**Custom fields a crear** (4):
- `whatsapp_url` — link directo a la conversación de Chatwoot. Crítico para saltar de Twenty a Chatwoot con 1 click. Formato: `https://crm.fomologic.com/app/accounts/1/conversations/{id}`.
- `first_contact_at` — timestamp del primer mensaje. Útil para métricas.
- `last_contact_at` — timestamp del último mensaje. Útil para saber qué leads están activos.
- `message_count` — cuántos mensajes intercambiaron. Útil para señalar engagement.

### 3.3 Campos en Opportunity

**Estándar de Twenty**:
- `name` — generado: "Lead - {Person.name} - {fecha}".
- `stage` — enum del schema actual: NEW | CONTACTED | MEETING | PROPOSAL | WON | LOST.
- `pointOfContactId` — link al Person.
- `companyId` — link a Company si aplica.

**Custom fields a crear** (3):
- `source` — enum: whatsapp | web | telegram | otro. Default whatsapp.
- `arquetipo` — enum: caliente | a-explorar | sin-claridad | no-lead. Lo agrega el backoffice cuando clasifica.
- `exception` — enum nullable: pedido-humano | consultoría | urgencia | reclamo | demo. Solo cuando aplica.

### 3.4 Notes / Activities

Cuando hay handoff, FAMA crea una **Note** asociada al Person con:
- Title: "Conversación FOMO - {fecha}"
- Body: resumen estructurado de la conversación (lo mismo que ya genera la nota privada en Chatwoot, formato consistente).

---

## 4. Lógica de upsert

### 4.1 Cuándo se ejecuta el upsert

**En cada turno relevante**:

1. **Primer mensaje del cliente**: crear Person (si no existe) con stage NEW.
2. **Discovery completo** (cliente dio nombre + empresa + caso + plazo): update con info, mover a CONTACTED.
3. **Backoffice clasifica arquetipo**: update con `arquetipo`.
4. **Handoff disparado**: update con stage (MEETING o lo que aplique según excepción), `exception`, agregar Note con resumen.
5. **NURTURING marca LOST**: update con stage LOST.

**No ejecutar** en cada mensaje. Solo cuando hay info nueva relevante.

### 4.2 Lookup-then-act (no race conditions)

Algoritmo:

```
1. GET Person WHERE phones contains {phone}
2. Si existe → tenés el personId
   → GET Opportunity WHERE pointOfContactId = personId
3. Si no existe Person → CREATE Person
   → CREATE Opportunity asociada
4. Update con merge inteligente (ver 4.3)
```

Idempotencia: si entran 2 mensajes simultáneos del mismo phone, el segundo va a ver el Person ya creado por el primero (en el peor caso ambos crean dos, pero la dedupe de message_id de FAMA reduce mucho el chance).

### 4.3 Merge inteligente (Opción B)

Regla universal: **NO sobrescribir un campo que ya tiene valor**.

```
Para cada campo:
  Si campo en Twenty está vacío Y FAMA tiene valor → set campo
  Si campo en Twenty tiene valor → NO TOCAR
  Excepción: campos "siempre actualizables":
    - last_contact_at
    - message_count
    - stage (puede subir, pero NUNCA bajar — ej. de MEETING no volver a NEW)
    - notes (apendear, no reemplazar)
```

**Stage progression** (importante):

```
NEW → CONTACTED → MEETING → PROPOSAL → WON
                                       → LOST
```

FAMA puede mover el stage **adelante**, nunca atrás. Si ya está en MEETING y el siguiente turno sería NEW, no hacer nada.

### 4.4 Identificación del nombre

Cuando entra primer mensaje y no se sabe el nombre:

1. Leer `profile.name` del payload de Chatwoot (WhatsApp lo provee).
2. Si está → usar como `name`.
3. Si no → `name = "Anónimo"`.
4. En cualquier caso, el `phone` es el identificador real.
5. Cuando el cliente diga su nombre real en la conversación, update.

### 4.5 Company (cuando se menciona empresa)

1. Cliente menciona empresa → backoffice extrae el nombre.
2. GET Company WHERE name ilike {empresa}.
3. Si existe → usar el companyId.
4. Si no → CREATE Company con name + nada más (los otros campos los completás vos a mano si querés).
5. Linkear Person.companyId.

---

## 5. Manejo de errores (Opción B)

### 5.1 Retry simple

```
Para cada llamada a Twenty:
  Intento 1: si falla por network/5xx → wait 5s → retry
  Intento 2: si falla → wait 10s → retry
  Intento 3: si falla → wait 15s → retry
  Si después de 3 fallos → log "twenty upsert failed" + sigue
```

**El cliente nunca ve falla** por culpa de Twenty. La conversación sigue normal.

### 5.2 Errores 4xx (validación, auth)

NO retry. Loguear `error: 'twenty_validation_error'` con el body de error y seguir. Esos son bugs nuestros, no flakiness de la red.

### 5.3 Si Twenty está completamente caída

Después de 3 fallos, lead se pierde silenciosamente en Twenty pero la conversación con el cliente sigue. **Anotamos como deuda menor**: si en 2-3 semanas vemos pérdidas significativas, migramos a Opción C (queue interna).

### 5.4 Logging estructurado

Cada operación contra Twenty:

```json
{
  "tool": "upsert-twenty-lead",
  "operation": "create_person" | "update_person" | "create_opportunity" | etc.,
  "personId": "...",
  "phone": "+549...",
  "stage": "NEW",
  "duration_ms": 234,
  "result": "success" | "retry_succeeded" | "failed_after_retries"
}
```

Esto permite grep + métricas básicas.

---

## 6. Implementación técnica

### 6.1 Reemplazar el MOCK

Archivo: `src/mastra/tools/upsert-twenty-leads.ts`.

**Hoy**:
```typescript
execute: async (input) => {
  logger.info({ mockTool: 'upsert-twenty-lead', input }, '// MOCK: upsert-twenty-lead');
  return { success: true, leadId: `mock-${Date.now()}` };
}
```

**Cambio**: el `execute` llama a un cliente nuevo en `src/lib/twenty.ts` que abstrae la API.

### 6.2 Nuevo módulo `src/lib/twenty.ts`

Funciones expuestas:

```typescript
// Lookup
findPersonByPhone(phone: string): Promise<Person | null>
findCompanyByName(name: string): Promise<Company | null>
getOpportunityByPersonId(personId: string): Promise<Opportunity | null>

// Create
createPerson(input: CreatePersonInput): Promise<Person>
createCompany(input: CreateCompanyInput): Promise<Company>
createOpportunity(input: CreateOpportunityInput): Promise<Opportunity>
createNote(personId: string, title: string, body: string): Promise<Note>

// Update
updatePerson(personId: string, patch: Partial<Person>): Promise<Person>
updateOpportunity(opportunityId: string, patch: Partial<Opportunity>): Promise<Opportunity>

// Helpers
mergeIntelligently(existing: any, incoming: any): any  // implementa 4.3
canAdvanceStage(from: Stage, to: Stage): boolean  // implementa 4.3 stage progression
```

### 6.3 Schema input — agregar 6 campos

Modificar `upsertTwentyLeadInput`:

```typescript
export const upsertTwentyLeadInput = z.object({
  name: z.string().optional(),
  phone: z.string().min(1),  // <— viene por RequestContext, no por LLM
  email: z.string().email().optional(),
  company: z.string().optional(),
  stage: z.enum(TWENTY_LEAD_STAGES),
  source: z.enum(TWENTY_LEAD_SOURCES).default('whatsapp'),
  notes: z.string().optional(),
  // Nuevos campos:
  arquetipo: z.enum(['caliente', 'a-explorar', 'sin-claridad', 'no-lead']).optional(),
  exception: z.enum(['pedido-humano', 'consultoria', 'urgencia', 'reclamo', 'demo']).optional(),
  // whatsapp_url, first_contact_at, last_contact_at, message_count
  // se computan internamente, no vienen del LLM:
});
```

**IMPORTANTE**: `phone` viene por `RequestContext`, no por schema del LLM (lección de v1). Hay que ajustar el flow para que lo lea de ahí.

### 6.4 Custom fields en Twenty

**Antes de codear**, hay que crear los 7 custom fields en Twenty (4 en Person + 3 en Opportunity).

**Opción A**: Vos los creás manualmente en la UI de Twenty (15 min). Más simple.

**Opción B**: Claude Code los crea via API. Más reproducible pero requiere conocer la API de schema management de Twenty (puede no estar expuesta).

Mi recomendación: **Opción A**. 15 min de tu tiempo, evitás el riesgo de complicación con API de schema. Anotás los nombres exactos de los campos para que Claude Code los use.

### 6.5 Variables de entorno nuevas

En el compose y Dockploy:

```
TWENTY_API_URL=https://crm.tu-twenty.com/graphql  (o REST)
TWENTY_API_KEY=<token>
TWENTY_OWNER_USER_ID=<uuid del user Mariano en Twenty>
```

### 6.6 Tests

- Unit tests del módulo `twenty.ts` con mocks (no llamar Twenty real en CI).
- Test de `upsert-twenty-lead` que verifique:
  - Person nuevo se crea bien.
  - Person existente se actualiza con merge.
  - Stage no baja.
  - Retry funciona en error 5xx.
  - 4xx no hace retry.
  - Note se crea en handoff.

---

## 7. Plan de implementación

### Día 1 — Mañana

1. **Mariano** (15 min): crea los 7 custom fields en la UI de Twenty.
2. **Mariano** (5 min): obtiene el `userId` de Mariano en Twenty para el env var.
3. **Claude Code** (15 min): explora la API de Twenty self-hosted, confirma endpoints, autenticación, formato.
4. **Claude Code** (1-2 hs): implementa `src/lib/twenty.ts` con todas las funciones de 6.2.
5. **Claude Code** (1 hora): refactoriza `upsert-twenty-leads.ts` para usar el nuevo cliente.
6. **Claude Code** (1 hora): ajusta el flow para pasar `phone` por RequestContext.

### Día 1 — Tarde

7. **Claude Code** (1-2 hs): tests unitarios + integración.
8. **Claude Code** (30 min): typecheck + npm test verde.
9. **Mariano** (revisa): diff + outputs.
10. **Commit + push**.
11. **Dockploy**: agregar env vars nuevas, redeploy.
12. **Test end-to-end**: Mariano manda mensaje desde WhatsApp, verifica que aparece en Twenty con todos los campos.

### Validación

Casos de test reales:

- **Caso A**: cliente nuevo manda primer mensaje → Person creado, Opportunity NEW.
- **Caso B**: mismo cliente vuelve a mandar 2 días después → Person updated (no duplicado), `last_contact_at` actualizado, `message_count++`.
- **Caso C**: cliente menciona empresa por primera vez → Company creada, Person.companyId actualizado.
- **Caso D**: cliente pide hablar con humano → Opportunity stage = MEETING, exception = "pedido-humano", Note creada con resumen.
- **Caso E**: NURTURING marca lead como LOST → Opportunity stage = LOST.

---

## 8. Decisiones registradas (van a CLAUDE.md como D14-D17)

- **D14**: Twenty integration usa 3 entidades — Person + Company + Opportunity. Phone es primary key, email secondary.
- **D15**: Update con merge inteligente (Opción B). NO sobrescribir campos llenos. Stage solo avanza, nunca retrocede.
- **D16**: Manejo de errores con retry simple (3 intentos / 30 seg). Si falla todo, log + sigue. Migrar a queue async si en 2-3 semanas se ve flakiness.
- **D17**: 6 custom fields agregados al schema (arquetipo, exception, whatsapp_url, first/last_contact_at, message_count) — útiles para filtros y métricas en Twenty.

---

## 9. Deudas anotadas para v3

- **Reporting Agent diario**: agente nuevo que lee Twenty diariamente y reporta a Mariano (leads nuevos, calientes, en MEETING, etc.).
- **Queue async para upserts (Opción C)**: si Opción B no alcanza.
- **Auto-creación de custom fields**: vía API de Twenty schema management (si está expuesta).
- **Métricas dashboard**: ver tasa de captura, tasa de escalación, tiempos, etc.

---

## 10. Riesgos identificados

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| API de Twenty self-hosted con quirks no documentados | Media | Exploración previa de Claude Code antes de empezar |
| Custom fields no se pueden crear via API | Media | Plan B: creación manual en UI |
| Race condition en upsert de Person nuevo | Baja | Dedupe de message_id de FAMA + lookup-then-act |
| Twenty caída durante uso real | Baja | Retry 3x + log + sigue |
| GraphQL vs REST confusion | Media | Confirmar en exploración previa |
| Mocks viejos en Twenty interfieren | Muy baja | Distintos phones, no se cruzan |

---

## 11. Definición de "hecho"

Sprint 1 está cerrado cuando:

- [ ] Tool `upsert-twenty-lead` llama a Twenty real (NO MOCK).
- [ ] Person se crea o actualiza correctamente.
- [ ] Company se crea o asocia.
- [ ] Opportunity se crea con stage correcto.
- [ ] Notes se crean en handoff.
- [ ] 7 custom fields se llenan correctamente.
- [ ] Owner es Mariano por default.
- [ ] Merge inteligente funciona (validado con caso B).
- [ ] Stage solo avanza (validado con test).
- [ ] Retry funciona (validado con test).
- [ ] Tests pasan en CI.
- [ ] Test end-to-end con WhatsApp real verifica que el lead aparece en Twenty completo.
- [ ] CLAUDE.md actualizado con D14-D17.

---

## 12. Próximos sprints v2

- **Sprint 2**: Multimodalidad (audios + imágenes). Empezar después de cerrar Sprint 1.
- **Sprint 3**: Calendly integration (recomendación) o Calendar agent nativo (si Mariano cambia de opinión post-Sprint 1).