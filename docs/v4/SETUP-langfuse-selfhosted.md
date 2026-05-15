# Setup operacional — Langfuse self-hosted en el VPS

**Fecha**: 2026-05-12
**Owner**: Mariano

Pasos para levantar Langfuse self-hosted en el VPS de Hostinger y conectarlo a FAMA.

---

## 1. Decidir el subdominio

Por consistencia con el resto del stack:
- `langfuse.fomologic.com` (recomendado).
- Asegurate que el A record apunte al IP del VPS antes de seguir.

## 2. Levantar Langfuse en el VPS

Langfuse oficial tiene `docker-compose.yml` listo. Approach: clonar en el VPS bajo un proyecto Dockploy separado.

**Variante A — Dockploy UI (recomendada)**:

1. En Dockploy UI → Crear nuevo proyecto "langfuse".
2. Source: docker-compose. Usar el oficial de https://github.com/langfuse/langfuse/blob/main/docker-compose.yml (versión 3 — la actual a 2026-05-12 que matchea con `@mastra/langfuse@1.x` que usa el SDK v5 de Langfuse).
3. Env vars en Dockploy:
   - `NEXTAUTH_SECRET`: generar con `openssl rand -base64 32`
   - `SALT`: generar con `openssl rand -base64 32`
   - `ENCRYPTION_KEY`: generar con `openssl rand -hex 32`
   - `NEXTAUTH_URL`: `https://langfuse.fomologic.com`
   - `LANGFUSE_INIT_ORG_ID`: `fomo` (o el id que quieras)
   - `LANGFUSE_INIT_PROJECT_ID`: `fama` (project específico de FAMA — si en el futuro hay agente #2 podemos crear otro proyecto en la misma instancia)
   - `LANGFUSE_INIT_USER_EMAIL`: tu email
   - `LANGFUSE_INIT_USER_PASSWORD`: contraseña inicial (cambiar al primer login)
4. Configurar Traefik en `/etc/dokploy/traefik/dynamic/langfuse.yml` siguiendo el patrón de `fama.yml` (basic auth opcional al inicio para no exponer públicamente la UI mientras se valida).

**Variante B — docker-compose manual**:

```bash
ssh hostinger-fomo
mkdir -p ~/langfuse && cd ~/langfuse
curl -O https://raw.githubusercontent.com/langfuse/langfuse/main/docker-compose.yml
# Editar env vars en el compose (o crear .env)
docker compose up -d
```

## 3. Verificar que Langfuse está arriba

```bash
ssh hostinger-fomo "docker ps | grep langfuse"
# Web debe estar Up + healthy
curl -I https://langfuse.fomologic.com/api/public/health
# 200 OK
```

Loggearse en `https://langfuse.fomologic.com` con el user inicial. Si es el primer login, te pide cambiar contraseña.

## 4. Crear API keys

En Langfuse UI:
1. Settings → API Keys → **+ New Key**.
2. Nombre: `fama-production`.
3. Copiar **Public key** y **Secret key** (la secret no se muestra de nuevo).

## 5. Configurar FAMA

En Dockploy (proyecto fama), agregar env vars:

```
LANGFUSE_BASE_URL=https://langfuse.fomologic.com
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxxxxxxxxxxxxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxxxxxxxxxxxxxxxxxx
```

Redeploy del container de FAMA. Verificar en logs:

```bash
ssh hostinger-fomo "docker logs tools-fama-fama-1 --tail 50 | grep -i langfuse"
# Esperar: 'observability: Langfuse exporter registered'
# baseUrl: https://langfuse.fomologic.com
```

Si dice `Langfuse not configured`, las env vars no se cargaron — chequear Dockploy.

## 6. Validar end-to-end

1. Desde tu WhatsApp personal, mandate "hola, info de empleados de IA".
2. FAMA debería procesar el mensaje (welcome o LLM según largo).
3. En Langfuse UI → Traces:
   - Debe aparecer una **session** con id `chatwoot-<id>`.
   - Dentro, un trace con el `recepcionista.generate()`.
   - Si hubo tool calls (knowledge-search), aparecen como spans anidados.
   - Si delegó al backoffice, aparece como sub-span.

4. Validar metadata:
   - `session.id` = `chatwoot-<conversationId>`
   - `user.id` = `contact-<contactId>`
   - Metadata con `phone`, `contactName`

## 7. Próximos pasos

Una vez Langfuse esté operativo y poblándose con datos reales:
- **Sprint 2 (v4)**: aprovechar `mastra.shutdown()` y los nuevos workers para graceful shutdown + fallback OpenAI down.
- **Sprint 3 (v4)**: usar Langfuse como destination de los traces del eval set para comparar comportamiento esperado vs producción.

## Backup

Langfuse persiste en PostgreSQL + ClickHouse (incluidos en el compose oficial). El backup del VPS (deuda pendiente del Bloque 1 del plan maestro) cubre estos volúmenes también.

---

## Troubleshooting

**FAMA logea "Langfuse exporter registered" pero no aparecen traces en UI**:
- Verificar que `LANGFUSE_BASE_URL` tiene el protocolo `https://`.
- Verificar que la URL es accesible desde dentro del container: `docker exec tools-fama-fama-1 wget -O- https://langfuse.fomologic.com/api/public/health`.
- Revisar logs de FAMA: `docker logs tools-fama-fama-1 | grep -iE "langfuse|export"`.
- Esperar 30-60s — Langfuse hace flush batch periódico, no en cada span.

**Quiero forzar flush inmediato para debug**:
- Setear `LANGFUSE_REALTIME=true` (no implementado todavía; si se necesita, agregar al exporter config con `realtime: true`).

**El UI de Langfuse muestra todo bajo "default" en lugar de "fama"**:
- Verificar `LANGFUSE_INIT_PROJECT_ID=fama` en el compose de Langfuse.
- La API key debe ser del proyecto correcto (re-crear si era de otro).
