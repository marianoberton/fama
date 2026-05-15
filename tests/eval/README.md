# FAMA Eval Set (v4 Sprint 3)

Conjunto de casos canónicos que se ejecutan contra el LLM real para detectar
regresiones en el comportamiento de los agentes (recepcionista, backoffice,
agendador). Corre en CI antes de cada merge a `main`.

## Cómo correr

```bash
# Local (requiere OPENAI_API_KEY en .env):
npm run eval

# CI: GitHub Actions lo dispara automáticamente en cada PR a main.
```

## Estructura

```
tests/eval/
├── README.md          # Este archivo
├── types.ts           # EvalCase + EvalResult interfaces
├── runner.ts          # Runner principal (tsx tests/eval/runner.ts)
└── cases/
    ├── arquetipo-1-caliente.yaml
    ├── arquetipo-2-explorar.yaml
    ├── excepcion-1-pedido-humano.yaml
    ├── excepcion-3-urgencia.yaml
    └── edge-anti-hallucination.yaml
```

## Formato de un caso

```yaml
case: nombre-unico-del-caso
description: |
  Descripción del escenario en lenguaje natural.
category: arquetipo | excepcion | edge
hard: true    # true = bloquea merge si falla; false = solo warning
turns:
  - "Primer mensaje del cliente"
  - "Segundo mensaje (opcional)"
  - "Tercer mensaje (opcional)"
expect:
  # Cualquier subconjunto de:
  toolsCalled:
    - upsert-twenty-lead
    - chatwoot-handoff
  delegatedTo:
    - backoffice
    - agendador
  toolArgsMatch:
    upsert-twenty-lead:
      stage: MEETING
      arquetipo: caliente
  finalResponseMatches:
    - "(asesor|equipo|coordinamos)"  # regex case-insensitive
  finalResponseDoesNotMatch:
    - "(qued[óo] agendada|te env[íi]o)"  # anti-hallucination
```

## Aserciones disponibles

| Aserción | Significado |
|---|---|
| `toolsCalled` | Lista de tools que DEBEN haberse llamado al menos una vez en toda la conversación |
| `delegatedTo` | Sub-agentes a los que DEBE delegar (backoffice, agendador) |
| `toolArgsMatch` | Match parcial de args contra al menos UNA invocación del tool |
| `finalResponseMatches` | El último response del agente DEBE matchear estas regex (case-insensitive) |
| `finalResponseDoesNotMatch` | El último response NO debe matchear (útil para detectar alucinaciones) |

## Hard vs Soft

- `hard: true` — Falla bloquea el merge a `main`. Usar para comportamientos
  críticos (escalación de pedido humano, no-hallucination, stages correctos).
- `hard: false` — Falla solo advierte en logs. Usar para wording/tono que
  puede variar legítimamente entre runs del LLM.

## Cómo agregar un caso

1. Crear `tests/eval/cases/<categoria>-<nombre>.yaml` siguiendo el formato.
2. Correr `npm run eval` localmente para validar.
3. Verificar que pasa al menos 2 veces seguidas (los LLMs tienen variance).
4. Si pasa consistentemente: commit + push.
5. Si falla > 20% de las veces y el comportamiento del LLM es correcto: marcar `hard: false`.

## Costos

Cada caso ejecuta cada turno contra `gpt-4o-mini` (recepcionista) y posiblemente
`gpt-4o` (backoffice si delega). Estimado:

- Por turno: ~USD 0.005-0.02
- Por caso (1-3 turns): ~USD 0.01-0.06
- Suite completa actual (5 casos): ~USD 0.10-0.30 por run

Cada PR a `main` corre el suite. Si el costo se vuelve un problema (suite
grande + muchos PRs), agregar sampling: correr solo casos por categoría
afectada según los archivos modificados en el PR.

## Limitaciones conocidas

- **Variance del LLM**: los modelos no son determinísticos. Un caso puede
  pasar 95% de las veces y fallar el 5%. Estrategias:
  - Usar `temperature: 0` en agentes (no implementado todavía).
  - Hacer aserciones lo más amplias posible (regex con alternativas).
  - Marcar como `hard: false` los casos con variance > 20%.
- **No prueba el path completo del webhook**: el runner llama
  `recepcionista.generate()` directamente, sin pasar por `handleChatwootWebhook`.
  La ruta `dedup → welcome-or-LLM → post Chatwoot` está cubierta por los tests
  unitarios en `tests/server/orchestration.test.ts`.
- **Fetch de Chatwoot/Twenty/Calendar es stub**: el runner mockea `fetch`
  para devolver 200 vacío en todo lo que no sea OpenAI. Las tools "creen" que
  funcionaron pero no escriben a sistemas reales — eso es lo que queremos.
