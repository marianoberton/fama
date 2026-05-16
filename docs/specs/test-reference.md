# FAMA — Test de Referencia (End-to-End)

## Test 1: Conversación completa → Handoff

```yaml
name: "Lead caliente con handoff"
description: |
  Simula una conversación completa donde un cliente interesado
  en empleados de IA pasa por recepcionista → backoffice → handoff.

setup:
  env:
    OPENAI_API_KEY: "sk-test"
    CHATWOOT_BASE_URL: "http://localhost:8080"
    CHATWOOT_ACCOUNT_ID: 1
    CHATWOOT_INBOX_ID: 3
    CHATWOOT_AGENT_BOT_ID: 2
    CHATWOOT_TEAM_ID: 1
    CHATWOOT_PATH_TOKEN: "test-token"
    CHATWOOT_API_TOKEN: "test-api-token"
    TWENTY_API_URL: "http://localhost:3000"
    TWENTY_API_KEY: "test"
    TWENTY_OWNER_USER_ID: "test"
    NODE_ENV: "test"
  mocks:
    - service: chatwoot
      endpoint: POST /api/v1/accounts/1/conversations/123/messages
      response: { id: 999 }
    - service: chatwoot
      endpoint: POST /api/v1/accounts/1/conversations/123/labels
      response: { success: true }
    - service: chatwoot
      endpoint: POST /api/v1/accounts/1/conversations/123/assignments
      response: { success: true }
    - service: chatwoot
      endpoint: POST /api/v1/accounts/1/conversations/123/toggle_status
      response: { success: true }
    - service: twenty
      endpoint: POST /graphql
      response:
        data:
          people: { edges: [] }
          createPerson: { id: "person-123" }
          createOpportunity: { id: "opp-123" }

steps:
  # --- Turno 1: Bienvenida ---
  - name: "Cliente saluda"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 123
        status: pending
        messages:
          - id: 1
            content: "Hola"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202
      response:
        handled: welcome
      chatwoot_calls:
        - POST /messages
          body.content: "Hola, gracias por escribirnos. Soy FAMA..."

  # --- Turno 2: Presentación empresa ---
  - name: "Cliente presenta empresa"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 123
        status: pending
        messages:
          - id: 2
            content: "Hola soy Juan de Acme SA, tenemos 50 empleados y queremos automatizar atención al cliente con IA"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202
      response:
        handled: collecting_data
      # Recepcionista debe pedir timeline/caso

  # --- Turno 3: Cliente da timeline ---
  - name: "Cliente da timeline"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 123
        status: pending
        messages:
          - id: 3
            content: "Necesitamos implementar esto en el próximo trimestre, tenemos presupuesto de 5k USD mensual"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202
      response:
        handled: escalated
      chatwoot_calls:
        - POST /messages
          body.content: "Listo, te derivo con Mariano..."
        - POST /labels
          body.labels: ["venta-agentes"]
        - POST /messages
          body.private: true
        - POST /assignments
          body.team_id: 1
        - POST /toggle_status
          body.status: open
      twenty_calls:
        - POST /graphql
          variables.stage: "MEETING"
          variables.source: "whatsapp"
```

## Test 2: Consulta simple → Respuesta directa

```yaml
name: "Consulta de pricing"
description: "Cliente pregunta precio, FAMA responde directo"

steps:
  - name: "Cliente pregunta precio"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 124
        status: pending
        messages:
          - id: 1
            content: "Cuánto cuesta un empleado de IA?"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202
      response:
        handled: direct_response
      # NO debe llamar a handoff
      # NO debe llamar a twenty
```

## Test 3: Excepción rígida → Handoff inmediato

```yaml
name: "Reclamo"
description: "Cliente hace reclamo, FAMA escala inmediatamente"

steps:
  - name: "Cliente reclama"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 125
        status: pending
        messages:
          - id: 1
            content: "Estoy muy enojado, contraté el servicio y no funciona"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202
      response:
        handled: escalated
      chatwoot_calls:
        - POST /labels
          body.labels: ["reclamo"]
        - POST /messages
          body.private: true
          body.content_contains: "RECLAMO"
```

## Test 4: Nurturing worker

```yaml
name: "Nurturing retry"
description: "Conversación inactiva 4hs, worker envía retry"

setup:
  db_state:
    nurturing_conversations:
      - conversation_id: 123
        last_inbound_at: "2026-05-16T10:00:00Z"  # hace 4hs
        retry_count: 0
        status: pending

steps:
  - name: "Worker tick"
    action: run_worker_tick
    now: "2026-05-16T14:00:00Z"
    expected:
      chatwoot_calls:
        - POST /messages
          body.content_contains: "te quería retomar"
      db_state:
        nurturing_conversations:
          - conversation_id: 123
            retry_count: 1
            last_retry_at: "2026-05-16T14:00:00Z"
```

## Test 5: Circuit breaker

```yaml
name: "Circuit breaker abierto"
description: "3 fallas seguidas abren el circuito"

setup:
  circuit_state:
    llm-recepcionista:
      failures: 3
      last_failure: "2026-05-16T14:00:00Z"

steps:
  - name: "Mensaje con circuito abierto"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 126
        status: pending
        messages:
          - id: 1
            content: "Hola"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202
      response:
        handled: circuit_breaker_fallback
      chatwoot_calls:
        - POST /messages
          body.content: "Disculpá, en este momento tengo un problema técnico..."
      # NO debe llamar a OpenAI
```

## Test 6: Deduplicación

```yaml
name: "Mensaje duplicado"
description: "Mismo message_id llega 2 veces"

steps:
  - name: "Primer mensaje"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 127
        status: pending
        messages:
          - id: 1
            content: "Hola"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202

  - name: "Mismo mensaje de nuevo"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 127
        status: pending
        messages:
          - id: 1
            content: "Hola"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 200
      response:
        ignored: duplicate
      # NO debe llamar a OpenAI
      # NO debe enviar mensaje
```

## Test 7: Auto-handback

```yaml
name: "Humano devuelve conversación al bot"
description: "Status cambia de open a pending, FAMA retoma"

setup:
  chatwoot_state:
    conversation_128:
      status: open
      assigned_to: human@fomo.com

steps:
  - name: "Humano cambia a pending"
    action: simulate_chatwoot_status_change
    conversation_id: 128
    new_status: pending

  - name: "Cliente escribe de nuevo"
    action: send_webhook
    payload:
      event: message_created
      account: { id: 1 }
      conversation:
        id: 128
        status: pending
        messages:
          - id: 1
            content: "Gracias por la info, tengo otra pregunta"
            message_type: 0
            sender: { type: contact }
    expected:
      status: 202
      response:
        handled: direct_response
      # FAMA debe responder normalmente
```
