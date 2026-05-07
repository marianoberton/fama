/**
 * list-calendar-slots — returns the next N free 30-min slots in AR business
 * hours, intersecting busy times across all configured calendars. Used by
 * the agendador agent when the customer wants a demo and the backoffice
 * already gathered Nivel 2 data.
 *
 * Phone comes from RequestContext (logging only — the slot lookup itself is
 * customer-agnostic). Returns an empty list with a `reason` when Calendar is
 * not configured, so the agendador can fall through to chatwoot-handoff.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import {
  isGoogleCalendarConfigured,
  fetchBusyIntervals,
  GoogleCalendarApiError,
} from '../../lib/google-calendar.js';
import {
  findAvailableSlots,
  formatSlotForHumans,
  slotToIso,
  WINDOW_DAYS,
  DEFAULT_SLOTS_OFFERED,
  AR_OFFSET_HOURS,
} from '../../lib/availability.js';

export const listCalendarSlotsInput = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(DEFAULT_SLOTS_OFFERED)
    .describe('Cantidad de slots a devolver. Default 2 — sólo subí esto si el cliente pidió más opciones.'),
});

export const listCalendarSlotsOutput = z.object({
  slots: z.array(
    z.object({
      /** Epoch ms del inicio del slot — pasalo verbatim a book-calendar-event. */
      slotStartMs: z.number(),
      /** Texto en castellano AR para mostrar al cliente, ej "martes 7 de mayo a las 11:00hs". */
      humanLabel: z.string(),
      startIso: z.string(),
      endIso: z.string(),
    }),
  ),
  /** Reason cuando slots está vacío. null si todo OK. */
  reason: z.string().nullable(),
});

export const listCalendarSlots = createTool({
  id: 'list-calendar-slots',
  description:
    'Devuelve los próximos N (default 2) slots libres de 30 min en horario AR (9-19hs) para coordinar una demo. Atraviesa los calendarios configurados (Mariano + Guille) y un slot solo aparece si está libre en TODOS. Aplica buffer de 15 min antes/después y nunca ofrece slots del mismo día. Si Google Calendar no está configurado, devuelve slots=[] con reason — en ese caso el agendador debe escalar a humano vía chatwoot-handoff.',
  inputSchema: listCalendarSlotsInput,
  outputSchema: listCalendarSlotsOutput,
  execute: async (input) => {
    if (!isGoogleCalendarConfigured()) {
      logger.warn('list-calendar-slots: Google Calendar not configured — returning empty');
      return { slots: [], reason: 'calendar_not_configured' };
    }
    const now = Date.now();
    // Look 7 days ahead. fetch busy gives us a slightly larger window so
    // events that start INSIDE day 7 but extend beyond aren't missed.
    const lookaheadMs = (WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;
    let busy;
    try {
      busy = await fetchBusyIntervals({
        startMs: now,
        endMs: now + lookaheadMs,
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'list-calendar-slots: freebusy query failed',
      );
      const reason = err instanceof GoogleCalendarApiError ? 'calendar_api_error' : 'unknown_error';
      return { slots: [], reason };
    }
    const free = findAvailableSlots({
      nowMs: now,
      busy,
      count: input.count,
    });
    if (free.length === 0) {
      logger.warn(
        { busyIntervals: busy.length, lookaheadDays: WINDOW_DAYS },
        'list-calendar-slots: no free slots in 7-day window',
      );
      return { slots: [], reason: 'no_free_slots' };
    }
    return {
      slots: free.map((s) => ({
        slotStartMs: s.startMs,
        humanLabel: `${formatSlotForHumans(s)} (UTC-${AR_OFFSET_HOURS})`,
        ...slotToIso(s),
      })),
      reason: null,
    };
  },
});
