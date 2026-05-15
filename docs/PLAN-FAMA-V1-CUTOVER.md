Vamos con la opción 1. La estructura de h2 = sección indexable es 
correcta y el problema fue de redacción mía, no del parser.

Cambios en src/knowledge/pricing.md:

1. "## Empleados de IA" → eliminar ese heading. La sección era 
   organizativa, no contenido propio. Las 4 cards de planes son las 
   secciones reales.

2. "### Starter" → "## Starter"
3. "### Equipo" → "## Equipo"  
4. "### Completo" → "## Completo"
5. "### Enterprise" → "## Enterprise"

El párrafo introductorio que estaba bajo "## Empleados de IA" 
("Cuatro planes que combinan fee mensual + setup único...") movelo 
al inicio del archivo, antes del primer plan, como párrafo de 
contexto sin heading. O integralo con el párrafo intro existente. 
Fijate qué queda más natural.

Las otras secciones del archivo se mantienen tal cual:
- ## Por qué los planes dicen "desde"
- ## Setup único: qué cubre  
- ## Modalidad de pago
- ## Consultoría en IA
- ## Capacitaciones en IA

Después:
- npm run test → debería volver a 93/93.
- Mostrame el contenido completo del nuevo pricing.md así confirmo 
  que el cambio quedó como esperaba antes del commit.
- Si tests verdes, commiteás con el mensaje que ya teníamos.

NO toques faqs.md ni el parser ni los tests.