# FAMA — Runbook de Deployment

Guía paso a paso para deployar FAMA desde cero en un VPS.

---

## 1. Prerrequisitos

### VPS
- Ubuntu 22.04+
- 2 vCPU, 4GB RAM mínimo
- Docker + Docker Compose instalado

### Servicios externos (necesitás crear antes)

| Servicio | Qué necesitás | Dónde crear |
|----------|--------------|-------------|
| **Chatwoot** | Cuenta self-hosted o cloud | https://www.chatwoot.com |
| **OpenAI** | API Key | https://platform.openai.com |
| **Twenty CRM** | Instancia self-hosted | https://twenty.com |
| **Google Calendar** | Service Account JSON | GCP Console |
| **Langfuse** (opcional) | Instancia self-hosted | https://langfuse.com |

---

## 2. Configurar Chatwoot

### 2.1 Crear Inbox de WhatsApp
1. Chatwoot → Settings → Inboxes → Add Inbox
2. Seleccionar "WhatsApp"
3. Configurar API de WhatsApp Business (o Twilio como fallback)
4. Guardar el `inbox_id`

### 2.2 Crear Agent Bot
1. Chatwoot → Settings → Agents → Add Agent
2. Nombre: "FAMA Bot"
3. Tipo: "Agent Bot" (no "Agent")
4. Guardar el `agent_bot_id`

### 2.3 Crear Labels
1. Chatwoot → Settings → Labels → Add Label
2. Crear cada uno:
   - `escalar-humano`
   - `venta-capacitacion`
   - `venta-agentes`
   - `venta-consultoria`
   - `reclamo`
   - `urgencia`

### 2.4 Configurar Webhook
1. Chatwoot → Settings → Integrations → Webhooks
2. URL: `https://tu-dominio.com/v1/webhooks/chatwoot/TU_PATH_TOKEN`
3. Seleccionar eventos: `message_created`, `conversation_status_changed`
4. Guardar el `path_token` (string aleatorio seguro)

### 2.5 Obtener API Token
1. Chatwoot → Profile → Access Tokens → New Token
2. Guardar el token (no se muestra de nuevo)

---

## 3. Configurar Twenty CRM

### 3.1 Instalar Twenty
```bash
docker run -d \
  --name twenty \
  -p 3000:3000 \
  -e SERVER_URL=https://twenty.tu-dominio.com \
  twentycrm/twenty:latest
```

### 3.2 Crear API Key
1. Twenty → Settings → API Keys → New
2. Guardar la key

### 3.3 Obtener Owner User ID
1. Twenty → Settings → Workspace Members
2. Click en tu usuario → copiar el ID (es el `workspaceMember.id`)

---

## 4. Configurar Google Calendar

### 4.1 Crear Service Account
1. GCP Console → IAM & Admin → Service Accounts → Create
2. Nombre: `fama-calendar`
3. Rol: `Calendar API → Calendar Service Agent`
4. Crear key JSON → descargar

### 4.2 Compartir Calendarios
1. Google Calendar → Configuración del calendario
2. Compartir con el email del service account (`fama-calendar@...`)
3. Dar permiso "Make changes to events"

### 4.3 Guardar IDs de calendarios
- Copiar el email del calendario principal (donde se crean eventos)
- Copiar emails de calendarios adicionales (solo lectura para busy)

---

## 5. Deployar FAMA

### 5.1 Clonar repo
```bash
git clone https://github.com/tu-org/fama.git
cd fama
```

### 5.2 Crear .env
```bash
cp .env.example .env
nano .env
```

Variables obligatorias:
```env
# OpenAI
OPENAI_API_KEY=sk-...

# Chatwoot
CHATWOOT_BASE_URL=https://chat.tu-dominio.com
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=3
CHATWOOT_AGENT_BOT_ID=2
CHATWOOT_TEAM_ID=1
CHATWOOT_PATH_TOKEN=token_secreto_aqui
CHATWOOT_API_TOKEN=...

# Twenty
TWENTY_API_URL=https://twenty.tu-dominio.com
TWENTY_API_KEY=...
TWENTY_OWNER_USER_ID=...

# Google Calendar (opcional pero recomendado)
GOOGLE_CALENDAR_CREDENTIALS_JSON={"type":"service_account",...}
CALENDAR_IDS_TO_CHECK=cal1@group.calendar.google.com,cal2@group.calendar.google.com
CALENDAR_PRIMARY=cal1@group.calendar.google.com

# Langfuse (opcional)
LANGFUSE_BASE_URL=https://langfuse.tu-dominio.com
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...

# App
NODE_ENV=production
PORT=4111
LOG_LEVEL=info
```

### 5.3 Build y run con Docker
```bash
docker build -t fama:latest .
docker run -d \
  --name fama \
  --env-file .env \
  -p 4111:4111 \
  -v fama-data:/app/data \
  fama:latest
```

### 5.4 Verificar health
```bash
curl http://localhost:4111/health
```

---

## 6. Configurar reverse proxy (Caddy/Nginx)

### Caddy
```
fama.tu-dominio.com {
    reverse_proxy localhost:4111
}
```

### Nginx
```nginx
server {
    listen 443 ssl;
    server_name fama.tu-dominio.com;

    location / {
        proxy_pass http://localhost:4111;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 7. Verificar integración

### 7.1 Test webhook
```bash
curl -X POST https://fama.tu-dominio.com/v1/webhooks/chatwoot/TU_PATH_TOKEN \
  -H "Content-Type: application/json" \
  -d '{
    "event": "message_created",
    "account": {"id": 1},
    "conversation": {
      "id": 123,
      "status": "pending",
      "messages": [{
        "id": 1,
        "content": "Hola, quiero info",
        "message_type": 0,
        "sender": {"type": "contact"}
      }]
    }
  }'
```

### 7.2 Ver logs
```bash
docker logs -f fama
```

### 7.3 Verificar Chatwoot
1. Enviar mensaje de prueba al número de WhatsApp
2. Verificar que FAMA responde
3. Revisar labels en Chatwoot

---

## 8. Troubleshooting

| Síntoma | Causa probable | Fix |
|---------|---------------|-----|
| FAMA no responde | Webhook mal configurado | Verificar URL y path token |
| 401 en webhook | Token inválido | Revisar `CHATWOOT_PATH_TOKEN` |
| FAMA responde a todo | Filtro no funciona | Revisar reglas en `filter.ts` |
| No guarda en Twenty | API key mal | Verificar `TWENTY_API_KEY` |
| No agenda demos | Calendar no configurado | Verificar `GOOGLE_CALENDAR_CREDENTIALS_JSON` |
| Circuit breaker abierto | LLM fallando | Revisar `OPENAI_API_KEY` y logs |
| Duplicados | Dedup no funciona | Verificar `dedup-store.ts` |

---

## 9. Backup

### Datos a backuppear
- `.env` (secrets)
- `mastra.db` (memoria LibSQL)
- `nurturing.db` (estado nurturing)

### Script de backup
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
tar czf /backups/fama_$DATE.tar.gz \
  /path/to/fama/.env \
  /path/to/fama/data/mastra.db \
  /path/to/fama/data/nurturing.db
```

---

## 10. Update

```bash
cd /path/to/fama
git pull
docker build -t fama:latest .
docker stop fama
docker rm fama
docker run -d --name fama --env-file .env -p 4111:4111 fama:latest
```
