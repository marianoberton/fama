export const CHATWOOT_VALID_LABELS = [
  'escalar-humano',
  'venta-capacitacion',
  'venta-agentes',
  'venta-consultoria',
  'reclamo',
  'urgencia',
] as const;

export type ChatwootLabel = (typeof CHATWOOT_VALID_LABELS)[number];

export function isValidChatwootLabel(value: string): value is ChatwootLabel {
  return (CHATWOOT_VALID_LABELS as readonly string[]).includes(value);
}
