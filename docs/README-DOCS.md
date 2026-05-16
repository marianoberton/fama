# FAMA — Documentación Completa

> Paquete de documentación para entender, replicar y operar FAMA.

---

## 📁 Estructura de docs/

```
docs/
├── README-DOCS.md              ← ESTE ARCHIVO (índice)
├── REPORTE-SALUD.md            ← Estado actual del código
├── RUNBOOK-DEPLOY.md           ← Deployment paso a paso
├── fama-design-v1.md           ← Diseño de comportamiento (fuente de verdad)
├── CLAUDE.md                   ← Decisiones del proyecto
│
├── diagrams/                   ← Diagramas Excalidraw
│   ├── arquitectura-general.excalidraw
│   ├── flujo-agentes.excalidraw
│   ├── integraciones-externas.excalidraw
│   └── fama-disenio-completo.excalidraw
│
├── specs/                      ← Especificaciones técnicas
│   ├── decision-tree.yaml      ← Árbol de decisiones ejecutable
│   ├── tool-specs.yaml         ← Contrato de cada tool
│   ├── scaffold-template.md    ← Template de proyecto
│   └── test-reference.md       ← Tests de referencia end-to-end
│
└── v2/, v4/                    ← Documentación de versiones futuras
```

---

## 🚀 Qué necesitás según tu rol

### Soy Mariano (fundador, quiero entender FAMA)

1. **Entender el flujo** → Abrí `fama-disenio-completo.excalidraw` en [excalidraw.com](https://excalidraw.com)
2. **Ver el estado actual** → Leé `REPORTE-SALUD.md`
3. **Decisiones de diseño** → Leé `fama-design-v1.md`

### Soy un dev (quiero replicar FAMA)

1. **Entender la arquitectura** → `arquitectura-general.excalidraw`
2. **Ver el árbol de decisiones** → `specs/decision-tree.yaml`
3. **Ver contratos de tools** → `specs/tool-specs.yaml`
4. **Scaffold del proyecto** → `specs/scaffold-template.md`
5. **Deployar** → `RUNBOOK-DEPLOY.md`

### Soy un QA (quiero testear)

1. **Tests de referencia** → `specs/test-reference.md`
2. **Flujo de agentes** → `flujo-agentes.excalidraw`

### Soy un ops (quiero operar)

1. **Deploy** → `RUNBOOK-DEPLOY.md`
2. **Integraciones** → `integraciones-externas.excalidraw`
3. **Troubleshooting** → `RUNBOOK-DEPLOY.md §8`

---

## 📊 Diagramas (links online)

| Diagrama | Link |
|----------|------|
| Arquitectura General | https://excalidraw.com/#json=OZew_mCG2Polspkq15ZJp,ZPYYp6MvrjZo5Jm0dspGqw |
| Flujo de Agentes | https://excalidraw.com/#json=RSD_PaeZc0p5W5fdRRk1f,Zf_J1WtutNWBBkEaMvi-AQ |
| Integraciones Externas | https://excalidraw.com/#json=7h1ufMy3aLRyIG4Ie4Qta,FT_Unyu-LFji8B3daovj0A |
| Diseño Completo | https://excalidraw.com/#json=qVIFgMLiik2qSoC2dGBYT,RuVRltpkzs1t93CW7jYtxw |

---

## 🧩 Specs técnicas

### decision-tree.yaml
Árbol de decisiones completo de FAMA como código. Define:
- Nodos de entrada, filtrado, dedup, circuit breaker
- Flujo del Recepcionista (Nivel 2, delegación)
- Flujo del Backoffice (4 arquetipos + 5 excepciones)
- Handoff a Chatwoot (5 pasos)
- Nurturing worker (retries, mark LOST)

### tool-specs.yaml
Contrato técnico de cada tool:
- `knowledge-search` — input/output, schema, errores
- `chatwoot-handoff` — 5 pasos de ejecución, idempotencia
- `upsert-twenty-lead` — GraphQL operations, upsert por teléfono
- `list-calendar-slots` — algoritmo de búsqueda
- `book-calendar-event` — creación + sincronización
- `auto-handback` — trigger de status change

### test-reference.md
7 tests end-to-end:
1. Lead caliente con handoff
2. Consulta simple → respuesta directa
3. Excepción rígida (reclamo)
4. Nurturing worker retry
5. Circuit breaker
6. Deduplicación
7. Auto-handback

---

## ⚠️ Estado conocido (2026-05-16)

- Bug: `logger` no importado en `src/lib/chatwoot.ts:314`
- Tests no corren por conflicto zod v3 vs v4
- Código funcional en dev, roto en CI

Ver `REPORTE-SALUD.md` para detalles.

---

## 🔄 Flujo de actualización

Cuando cambie el diseño:
1. Actualizar `fama-design-v1.md`
2. Regenerar `decision-tree.yaml`
3. Actualizar diagramas en Excalidraw
4. Actualizar `tool-specs.yaml` si cambian contratos
5. Actualizar `test-reference.md` si cambian casos de prueba
