/**
 * book-calendar-event — la tool central del agendador.
 *
 * Flow (CLAUDE.md "Calendar agent" + Sprint 3 design):
 *   1. Re-verifica que el slot sigue libre (race-condition guard contra el
 *      hueco entre list-calendar-slots y este turno).
 *   2. Crea el evento en Google Calendar primary con Meet auto-generado +
 *      attendees (cliente + Mariano + Guille). Calendar manda los mails.
 *   3. Twenty: findOrCreatePerson → updateOpportunity (stage=MEETING,
 *      arquetipo=CALIENTE, exception=null) → createNote + attachNoteToPerson
 *      con el detalle del evento.
 *   4. Chatwoot: postea nota privada al equipo con detalle + label venta-X.
 *      NO escala humano (D3 del sprint), NO postea al cliente (D4 del sprint
 *      — Calendar ya manda mail con el Meet, doble confirmación es ruido).
 *
 * Si paso 2 falla → success=false, error. La conversación sigue.
 * Si pasos 3 o 4 fallan → success=true igual, log ERROR. El evento ya está
 * creado (el cliente recibió el mail), no tiene sentido reventar el flow.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { loadEnv } from '../../config/env.js';
import {
  isGoogleCalendarConfigured,
  fetchBusyIntervals,
  createCalendarEvent,
  GoogleCalendarApiError,
  requireGoogleCalendarConfig,
} from '../../lib/google-calendar.js';
import { isSlotFree, slotToIso, formatSlotForHumans, BUFFER_MIN, SLOT_DURATION_MIN } from '../../lib/availability.js';
import {
  isTwentyConfigured,
  findOrCreatePersonByPhone,
  findOpportunityByPersonId,
  createOpportunity,
  updateOpportunity,
  createNote,
  attachNoteToPerson,
  canAdvanceStage,
} from '../../lib/twenty.js';
import {
  sendChatwootMessage,
  addChatwootLabels,
  ChatwootNotConfiguredError,
} from '../../lib/chatwoot.js';
import {
  CHATWOOT_VALID_LABELS,
  type ChatwootLabel,
} from '../../config/chatwoot-labels.js';

const SALES_CATEGORIES = [
  'venta-capacitacion',
  'venta-agentes',
  'venta-consultoria',
] as const;
type SalesCategory = (typeof SALES_CATEGORIES)[number];

export const bookCalendarEventInput = z.object({
  slotStartMs: z
    .number()
    .int()
    .positive()
    .describe(
      'Epoch ms del inicio del slot elegido — usá EXACTAMENTE el valor que devolvió list-calendar-slots. NO inventes ni redondees.',
    ),
  customerName: z
    .string()
    .min(1)
    .describe('Nombre completo del cliente, recolectado en el discovery.'),
  customerEmail: z
    .string()
    .email()
    .describe(
      'Email del cliente — Calendar le manda el mail de invitación con el link de Meet. Pedilo si no lo tenés.',
    ),
  category: z
    .enum(SALES_CATEGORIES)
    .describe(
      'Frente FOMO al que corresponde la demo. Determina la label de Chatwoot. capacitacion=cursos/workshops, agentes=empleados de IA, consultoria=consultoría estratégica.',
    ),
  summary: z
    .string()
    .min(1)
    .describe(
      'Título del evento de Calendar, ej "FOMO – Demo con Acme S.A. (agentes IA)". Conciso y profesional.',
    ),
  contextNote: z
    .string()
    .min(1)
    .describe(
      'Resumen estructurado del lead para el equipo. Mismo formato que la nota privada del handoff (Categoría / Motivo / Cliente / Empresa / Datos clave).',
    ),
});

export const bookCalendarEventOutput = z.object({
  success: z.boolean(),
  eventId: z.string().optional(),
  meetLink: z.string().optional(),
  htmlLink: z.string().optional(),
  /** Slot final agendado, en formato humano. */
  scheduledFor: z.string().optional(),
  error: z.string().optional(),
  /** Razón cuando success=false. */
  reason: z
    .enum(['calendar_not_configured', 'slot_taken', 'calendar_api_error', 'missing_request_context'])
    .optional(),
});

export interface BookEventContext {
  phone: string;
  conversationId: number;
  contactName: string;
}

/**
 * Pure executor — exported for testing with mocked deps. The createTool
 * wrapper pulls phone/conversationId/contactName from RequestContext.
 */
export async function runBookCalendarEvent(
  input: z.infer<typeof bookCalendarEventInput>,
  ctx: BookEventContext,
): Promise<z.infer<typeof bookCalendarEventOutput>> {
  if (!isGoogleCalendarConfigured()) {
    logger.warn(
      { phone: ctx.phone, slotStartMs: input.slotStartMs },
      'book-calendar-event: Google Calendar not configured — caller should escalate via chatwoot-handoff',
    );
    return { success: false, reason: 'calendar_not_configured' };
  }

  const slotEndMs = input.slotStartMs + SLOT_DURATION_MIN * 60 * 1000;
  const slot = { startMs: input.slotStartMs, endMs: slotEndMs };

  // === 1. Re-verify slot is still free (race-condition guard) ===
  try {
    const busy = await fetchBusyIntervals({
      startMs: input.slotStartMs - BUFFER_MIN * 60 * 1000,
      endMs: slotEndMs + BUFFER_MIN * 60 * 1000,
    });
    if (!isSlotFree({ slot, busy, bufferMs: BUFFER_MIN * 60 * 1000 })) {
      logger.warn(
        { phone: ctx.phone, slotStartMs: input.slotStartMs, busyCount: busy.length },
        'book-calendar-event: slot taken between list and book — caller must re-list',
      );
      return { success: false, reason: 'slot_taken' };
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, phone: ctx.phone },
      'book-calendar-event: freebusy re-check failed',
    );
    return {
      success: false,
      reason: 'calendar_api_error',
      error: (err as Error).message.slice(0, 300),
    };
  }

  // === 2. Create the event ===
  const config = requireGoogleCalendarConfig();
  // Internal attendees: every calendar in CALENDAR_IDS_TO_CHECK except the
  // primary (which is the organizer by virtue of being the calendarId where
  // we insert). Plus the customer.
  const internalAttendees = config.calendarIds.filter((id) => id !== config.primaryCalendarId);
  const attendeeEmails = [...internalAttendees, input.customerEmail];

  const eventDescription = [
    input.contextNote,
    '',
    `Cliente: ${input.customerName}`,
    `Teléfono: ${ctx.phone}`,
    `Email: ${input.customerEmail}`,
    `Conversación Chatwoot: ${loadEnv().CHATWOOT_BASE_URL}/app/accounts/${loadEnv().CHATWOOT_ACCOUNT_ID}/conversations/${ctx.conversationId}`,
  ].join('\n');

  let event;
  try {
    event = await createCalendarEvent({
      startMs: input.slotStartMs,
      endMs: slotEndMs,
      summary: input.summary,
      description: eventDescription,
      attendeeEmails,
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, phone: ctx.phone, slotStartMs: input.slotStartMs },
      'book-calendar-event: Calendar createEvent failed',
    );
    const reason = err instanceof GoogleCalendarApiError ? 'calendar_api_error' : 'calendar_api_error';
    return {
      success: false,
      reason,
      error: (err as Error).message.slice(0, 300),
    };
  }

  const scheduledFor = formatSlotForHumans(slot);
  const isoTimes = slotToIso(slot);
  logger.info(
    {
      eventId: event.eventId,
      meetLink: event.meetLink,
      scheduledFor,
      phone: ctx.phone,
      conversationId: ctx.conversationId,
    },
    'book-calendar-event: Calendar event created',
  );

  // === 3. Twenty sync (best-effort — failures here don't affect the customer) ===
  await syncToTwenty({
    phone: ctx.phone,
    contactName: ctx.contactName,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    eventId: event.eventId,
    meetLink: event.meetLink,
    htmlLink: event.htmlLink,
    scheduledFor,
    startIso: isoTimes.startIso,
    contextNote: input.contextNote,
    conversationId: ctx.conversationId,
  }).catch((err) => {
    logger.error(
      { err: (err as Error).message, phone: ctx.phone, eventId: event.eventId },
      'book-calendar-event: Twenty sync failed (event still created on Calendar)',
    );
  });

  // === 4. Chatwoot sync (best-effort — failures here don't affect the customer) ===
  await syncToChatwoot({
    conversationId: ctx.conversationId,
    customerName: input.customerName,
    scheduledFor,
    meetLink: event.meetLink,
    htmlLink: event.htmlLink,
    contextNote: input.contextNote,
    category: input.category,
  }).catch((err) => {
    logger.error(
      { err: (err as Error).message, conversationId: ctx.conversationId, eventId: event.eventId },
      'book-calendar-event: Chatwoot sync failed (event still created on Calendar)',
    );
  });

  return {
    success: true,
    eventId: event.eventId,
    ...(event.meetLink !== undefined ? { meetLink: event.meetLink } : {}),
    ...(event.htmlLink !== undefined ? { htmlLink: event.htmlLink } : {}),
    scheduledFor,
  };
}

async function syncToTwenty(input: {
  phone: string;
  contactName: string;
  customerName: string;
  customerEmail: string;
  eventId: string;
  meetLink?: string;
  htmlLink: string;
  scheduledFor: string;
  startIso: string;
  contextNote: string;
  conversationId: number;
}): Promise<void> {
  if (!isTwentyConfigured()) {
    logger.warn('book-calendar-event: Twenty not configured — skipping CRM sync');
    return;
  }
  const env = loadEnv();
  const whatsappUrl = `${env.CHATWOOT_BASE_URL}/app/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${input.conversationId}`;
  const fallbackFirstName = input.customerName.trim() || input.contactName.trim() || 'Anónimo';
  const { person } = await findOrCreatePersonByPhone({
    phone: input.phone,
    fallbackFirstName,
    whatsappUrl,
  });

  const opp = await findOpportunityByPersonId(person.id);
  if (opp) {
    if (canAdvanceStage(opp.stage, 'MEETING')) {
      await updateOpportunity(opp.id, {
        stage: 'MEETING',
        ...(opp.arquetipo ? {} : { arquetipo: 'CALIENTE' }),
      });
    }
  } else {
    await createOpportunity({
      name: `Demo - ${input.customerName} - ${input.startIso.slice(0, 10)}`,
      pointOfContactId: person.id,
      stage: 'MEETING',
      sourceChannel: 'WHATSAPP',
      arquetipo: 'CALIENTE',
    });
  }

  const noteBody = [
    `Demo agendada para ${input.scheduledFor}`,
    '',
    `Meet: ${input.meetLink ?? 'no se generó link de Meet'}`,
    `Calendar: ${input.htmlLink}`,
    `Email cliente: ${input.customerEmail}`,
    '',
    'Contexto del lead:',
    input.contextNote,
  ].join('\n');
  const note = await createNote({
    title: `Demo agendada - ${input.scheduledFor}`,
    body: noteBody,
  });
  await attachNoteToPerson({ noteId: note.id, personId: person.id });
}

async function syncToChatwoot(input: {
  conversationId: number;
  customerName: string;
  scheduledFor: string;
  meetLink?: string;
  htmlLink: string;
  contextNote: string;
  category: SalesCategory;
}): Promise<void> {
  // Validate the category is on the canonical list. Defensive — Zod already
  // restricts the input, but protects against changes to chatwoot-labels.
  if (!(CHATWOOT_VALID_LABELS as readonly string[]).includes(input.category)) {
    throw new Error(`book-calendar-event: invalid Chatwoot label '${input.category}'`);
  }
  const noteText = [
    `🗓 Demo agendada — ${input.scheduledFor}`,
    '',
    `Cliente: ${input.customerName}`,
    `Frente: ${input.category}`,
    `Meet: ${input.meetLink ?? '(sin link Meet)'}`,
    `Evento: ${input.htmlLink}`,
    '',
    'Contexto:',
    input.contextNote,
  ].join('\n');
  try {
    await sendChatwootMessage({
      conversationId: input.conversationId,
      content: noteText,
      private: true,
    });
  } catch (err) {
    if (err instanceof ChatwootNotConfiguredError) {
      logger.warn('book-calendar-event: CHATWOOT_API_TOKEN empty — note not posted');
    } else {
      throw err;
    }
  }
  try {
    await addChatwootLabels({
      conversationId: input.conversationId,
      labels: [input.category as ChatwootLabel],
    });
  } catch (err) {
    if (err instanceof ChatwootNotConfiguredError) {
      logger.warn('book-calendar-event: CHATWOOT_API_TOKEN empty — label not applied');
    } else {
      throw err;
    }
  }
}

export const bookCalendarEvent = createTool({
  id: 'book-calendar-event',
  description:
    'Crea el evento de Google Calendar para la demo elegida con Meet auto-generado, sincroniza Twenty (Person + Opportunity stage=MEETING + Note) y posta nota privada al equipo en Chatwoot con label venta-X. NO escala a humano (la reserva exitosa cierra el loop sin pasar por el inbox del equipo) y NO manda mensaje al cliente — Calendar le envía el mail con el Meet automáticamente. El phone se inyecta automáticamente desde el contexto del webhook. Si Calendar no está configurado, devuelve success=false reason=calendar_not_configured y el agendador debe escalar vía chatwoot-handoff.',
  inputSchema: bookCalendarEventInput,
  outputSchema: bookCalendarEventOutput,
  execute: async (input, context) => {
    const phone = context?.requestContext?.get('phone');
    const conversationId = context?.requestContext?.get('conversationId');
    const contactName = context?.requestContext?.get('contactName');
    if (typeof phone !== 'string' || !phone) {
      logger.error('book-calendar-event: phone missing from requestContext');
      return { success: false, reason: 'missing_request_context' as const };
    }
    if (typeof conversationId !== 'number') {
      logger.error('book-calendar-event: conversationId missing from requestContext');
      return { success: false, reason: 'missing_request_context' as const };
    }
    return runBookCalendarEvent(input, {
      phone,
      conversationId,
      contactName: typeof contactName === 'string' ? contactName : '',
    });
  },
});
