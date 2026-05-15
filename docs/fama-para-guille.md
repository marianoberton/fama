# FAMA, en simple

Doc para Guille, para que tengas el panorama completo: qué es FAMA, cómo está armada, y qué otros agentes podemos construir después con la misma base.

---

## Qué es FAMA

FAMA es el primer **empleado de IA** que estamos construyendo, y es para nosotros mismos. Es de la misma categoría que **Elena** (atención al cliente) en el catálogo de FOMO. Atiende WhatsApp y conversa con quien escribe a `+5491172343506`.

La diferencia con la "Elena del catálogo" es que FAMA está hecha específicamente para FOMO — sabe de nuestros planes, nuestro equipo, nuestros servicios. La misma estructura técnica se usa para hacer una "Elena para el cliente X", solo que con otra knowledge y otro prompt.

---

## Cómo es una conversación, paso a paso

Imaginate que María, dueña de una pyme, escribe *"Hola, quería info de empleados de IA"* al WhatsApp de FOMO.

1. **WhatsApp recibe el mensaje** y lo manda a Chatwoot (la plataforma de atención al cliente que ya usábamos).
2. **Chatwoot avisa a FAMA** mediante un *webhook* (una notificación HTTP que dice "che, llegó esto").
3. **FAMA filtra el evento**. No todo lo que avisa Chatwoot hay que procesar — si la conversación ya la está atendiendo un humano, FAMA se calla; si el mensaje lo escribió un agente humano y no el cliente, también se calla. Hay 6 reglas de filtrado, todas para evitar que FAMA hable cuando no le toca.
4. **Si es el primer mensaje y es corto** (menos de 30 palabras): FAMA contesta una bienvenida fija, sin gastar tokens del modelo. Esto ahorra plata y da una respuesta consistente.
5. **Si no es primer mensaje, o es uno largo**: pasa al cerebro principal, el **Recepcionista**.

### El Recepcionista

Es la cara de FAMA. Su trabajo:

- Entender qué quiere la persona.
- Hacer preguntas de *discovery* (¿qué empresa? ¿qué problema? ¿qué tamaño? ¿plazo?).
- Buscar info de FOMO cuando la necesita (precios, qué hacen los empleados, etc.).

Tiene una **biblioteca** (knowledge) con archivos sobre FOMO: identidad, empleados, servicios, precios, FAQs, argumentario de ventas. Cuando alguien pregunta *"¿cuánto sale el plan Equipo?"*, el Recepcionista busca en la biblioteca y arma la respuesta a partir de lo que encuentra.

**Cuando ve una oportunidad de venta clara, no la cierra él**: llama a su colega especialista, el **Backoffice**.

### El Backoffice (especialista de ventas)

Se activa solo cuando el Recepcionista lo invoca. No habla con el cliente al principio — recibe el contexto, piensa, decide qué hacer.

Tiene un árbol de decisión claro:

- ¿La persona pidió hablar con humano? → escalar.
- ¿Hay urgencia o reclamo? → escalar.
- ¿Tenemos los 4 datos mínimos (empresa, caso de uso, tamaño, plazo)? → registrar lead y/o escalar.
- ¿Faltan datos? → seguir conversando hasta tenerlos.

Cuando decide escalar a humano, llama a la tool **`chatwoot-handoff`** que hace 5 cosas en orden:

1. Postea un mensaje al cliente: *"te paso con un asesor"*.
2. Etiqueta la conversación (ej: `venta-agentes`, `urgencia`, `reclamo`).
3. Deja una **nota privada** con el contexto (solo la ven los humanos de FOMO en Chatwoot).
4. Asigna la conversación al equipo.
5. Cambia el estado a "open" para que un humano la tome.

### Cuando nadie responde

Si después de un rato el cliente no contesta, un proceso aparte llamado **Nurturing** chequea cada 15 minutos las conversaciones dormidas y manda recordatorios. Lo hace dentro de la ventana de 24h que permite Meta (más allá WhatsApp no deja escribir primero) y solo en horario AR (9-19hs). Después de 2 reintentos sin respuesta, marca el lead como perdido.

---

## Qué es Mastra (el framework)

**Mastra** es el framework con el que está construida FAMA. Pensalo como el "Excel" de los agentes: te da las planillas y las funciones, vos completás con la lógica de tu negocio.

Sus piezas principales:

### Agentes
Es lo que normalmente llamamos "el bot". Tiene un *prompt* (las instrucciones que le damos), un modelo (el cerebro — en este caso GPT-4o de OpenAI), y opcionalmente acceso a tools, knowledge y memoria.

### Tools (capacidades)
Las "manos" del agente. Sin tools, el agente solo puede conversar. Con tools, puede hacer cosas concretas: buscar info, escribir en una base de datos, asignar una conversación, mandar un mail.

### Knowledge (conocimiento)
Archivos que el agente puede consultar. Para FAMA son los `.md` con info de FOMO. Cuando el agente necesita un dato, busca en la knowledge antes de inventar.

### Memoria
Lo que el agente recuerda de conversaciones pasadas. Cada conversación tiene su propio hilo de memoria, así si María vuelve a escribir mañana, FAMA no arranca de cero.

### Workflows
Procesos de varios pasos que no necesariamente involucran a un agente. El Nurturing por ejemplo es un workflow programado.

### Multi-agente
Un agente puede invocar a otro. Eso es lo que hace el Recepcionista con el Backoffice. Mastra maneja toda la plomería: pasar contexto, separar memorias, registrar quién hizo qué.

---

## Cómo está estructurada FAMA hoy

```
FAMA
├── Agentes
│   ├── Recepcionista        modelo: gpt-4o-mini (más barato, conversación)
│   └── Backoffice           modelo: gpt-4o (más capaz, decisiones)
│
├── Tools
│   ├── knowledge-search     → buscar info de FOMO
│   ├── chatwoot-handoff     → escalar a humano (5 pasos en Chatwoot)
│   └── upsert-twenty-lead   → guardar lead en CRM (mock por ahora)
│
├── Knowledge (/src/knowledge)
│   ├── identity.md          → quiénes somos
│   ├── employees.md         → los 6 empleados de IA + Manager
│   ├── services.md          → 3 frentes de servicio
│   ├── pricing.md           → planes y precios
│   ├── faqs.md              → preguntas frecuentes
│   └── sales.md             → argumentario y objeciones
│
└── Workers (procesos en background)
    └── Nurturing            → reintenta leads dormidos cada 15 min
```

---

## Qué otros agentes podemos construir después

Esta es la parte interesante: la estructura de FAMA se puede replicar para cada empleado del catálogo. Lo que cambia es el prompt, las tools y la knowledge — el framework es el mismo.

### Mateo (cobranzas)
- **Recepcionista**: identifica al deudor, lee historial, calibra tono según perfil (cooperativo vs. evasivo).
- **Backoffice**: arma plan de pago, negocia, escala casos complejos.
- **Tools nuevas**: `consulta-saldo`, `genera-link-pago`, `programa-recordatorio`.
- **Knowledge nueva**: políticas de cobranza del cliente, scripts de negociación.

### Lucas (ventas)
- **Recepcionista**: califica leads, hace discovery, descarta consultas que no encajan.
- **Backoffice**: cotiza, agenda demo, cierra.
- **Tools nuevas**: `cotizar`, `agendar-demo`, `crear-propuesta`.
- **Knowledge nueva**: catálogo del cliente, precios, casos de éxito.

### Nadia (licitaciones)
- **Agente único** (no necesita la dupla recepcionista + backoffice): clasifica oportunidades, descarta las que no aplican.
- **Workflow**: arma la documentación necesaria leyendo plantillas y datos del cliente.
- **Tools nuevas**: `parsear-pliego`, `armar-anexo`, `validar-requisitos`.
- **Knowledge nueva**: pliegos pasados ganados, plantillas, datos legales del cliente.

### Franco (análisis de competencia)
- **Más workflow que agente conversacional**: corre periódicamente, no espera mensajes.
- **Tools nuevas**: `scrape-sitio`, `analizar-precios`, `genera-reporte`.
- **Knowledge nueva**: lista de competidores, criterios de comparación.

### Mia (asistente personal)
- **Agente conversacional con muchas tools**: agenda, mails, tareas.
- **Tools nuevas**: `crear-evento`, `responder-mail`, `crear-tarea`, `recordatorio`.
- **Knowledge nueva**: preferencias del jefe, contactos clave, criterios de filtro.

---

## Por qué el segundo agente sale más rápido que el primero

Mucho de lo que ya construimos para FAMA se reusa tal cual:

- **`chatwoot-handoff`**: cualquier agente que atienda WhatsApp via Chatwoot la puede usar igual.
- **`knowledge-search`**: el motor de búsqueda funciona con cualquier carpeta de `.md`.
- **El filtrado del webhook**: las 6 reglas son universales para Chatwoot.
- **El patrón Recepcionista + Backoffice**: aplica a cualquier flujo de "frontear" + "decidir".
- **El worker de Nurturing**: replicable para cualquier seguimiento de leads dormidos.
- **Toda la infra de deploy** (Docker, VPS, red, Studio): lista, no hay que rehacerla.

La primera vez resolvés todos los problemas de plomería (Chatwoot, Mastra, Docker, deploy, prompts). La segunda vez, copiás la estructura y solo cambiás el prompt + las tools específicas + la knowledge. Estimación: el segundo empleado debería tomar **3-5 días** vs. los ~7 días que tomó FAMA.

---

## Glosario rápido

- **Agente**: programa que conversa o ejecuta tareas usando un LLM como cerebro.
- **LLM**: Large Language Model. El "cerebro" — GPT-4o es un LLM de OpenAI.
- **Prompt**: las instrucciones que le damos al agente sobre cómo comportarse.
- **Tool**: capacidad del agente de hacer algo concreto, más que conversar.
- **Knowledge**: archivos que el agente puede consultar para no inventar datos.
- **Webhook**: notificación HTTP que un sistema (Chatwoot) le manda a otro (FAMA) cuando pasa algo.
- **Chatwoot**: plataforma de atención al cliente que ya usábamos. Centraliza WhatsApp, email, web chat.
- **Mastra**: framework TypeScript para construir agentes. Es el "esqueleto" de FAMA.
- **Multi-agente**: un agente que puede invocar a otros (como el Recepcionista al Backoffice).
- **Thread de memoria**: la "conversación" que un agente recuerda con un usuario específico.
- **Workflow**: proceso automatizado de varios pasos. Puede o no incluir agentes.
- **Studio**: la interfaz web local (`http://localhost:4111`) donde se prueban los agentes manualmente.

---

## Lo que sigue para FAMA

Para que FAMA salga a producción falta (en orden):

1. Que vos pruebes ~20 conversaciones en Studio y vayamos puliendo prompts.
2. Configurar el token real de Chatwoot en `.env`.
3. Deploy al VPS.
4. Smoke test con webhooks simulados.
5. Apuntar Chatwoot al endpoint nuevo.
6. Probar con WhatsApp real (1-2 mensajes desde el celu de Mariano).
7. Dejar el sistema viejo (fomo-core) corriendo 48h en paralelo, por si algo sale mal.
8. Si todo bien, jubilar fomo-core.

Una vez que FAMA esté andando estable, arrancamos con el segundo empleado de IA — probablemente Mateo (cobranzas) o Lucas (ventas), según qué cliente tengamos primero pidiéndolo.
