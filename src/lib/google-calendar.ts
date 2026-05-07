/**
 * Google Calendar client used by the agendador agent. Authenticates via a
 * service account JSON key (Workspace `@fomo.com.ar`), then queries free/busy
 * times across multiple calendars and creates events with Meet auto-generated.
 *
 * Setup that has to happen ONCE in GCP Console (operator task — see CLAUDE.md
 * "Multimodalidad → Calendar agent" for the step-by-step):
 *   1. Project + Calendar API enabled.
 *   2. Service account created, JSON key downloaded.
 *   3. Each calendar shared with the SA email ("Make changes to events").
 *   4. JSON pasted in .env as GOOGLE_CALENDAR_CREDENTIALS_JSON, calendar ids
 *      in CALENDAR_IDS_TO_CHECK + CALENDAR_PRIMARY.
 *
 * The client uses the `googleapis` SDK with JWT auth (no domain-wide
 * delegation — calendars are explicitly shared with the SA).
 */

import { google, calendar_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

export class GoogleCalendarNotConfiguredError extends Error {
  constructor() {
    super(
      'GOOGLE_CALENDAR_CREDENTIALS_JSON / CALENDAR_IDS_TO_CHECK / CALENDAR_PRIMARY are empty — set them in .env to enable the agendador',
    );
    this.name = 'GoogleCalendarNotConfiguredError';
  }
}

export class GoogleCalendarApiError extends Error {
  constructor(
    public readonly underlying: unknown,
    msg: string,
  ) {
    super(`Google Calendar API error: ${msg}`);
    this.name = 'GoogleCalendarApiError';
  }
}

export interface GoogleCalendarConfig {
  /** Service-account JSON parsed once. */
  credentials: { client_email: string; private_key: string };
  /** All calendar ids whose busy time must be intersected. */
  calendarIds: string[];
  /** Calendar where events are CREATED. */
  primaryCalendarId: string;
}

export function isGoogleCalendarConfigured(): boolean {
  const env = loadEnv();
  return (
    !!env.GOOGLE_CALENDAR_CREDENTIALS_JSON &&
    !!env.CALENDAR_IDS_TO_CHECK &&
    !!env.CALENDAR_PRIMARY
  );
}

let cachedConfig: GoogleCalendarConfig | undefined;
let cachedClient: calendar_v3.Calendar | undefined;

/** Test-only: clear cached config + client so a re-import picks up new env. */
export function _resetGoogleCalendarForTests(): void {
  cachedConfig = undefined;
  cachedClient = undefined;
}

export function requireGoogleCalendarConfig(): GoogleCalendarConfig {
  if (cachedConfig) return cachedConfig;
  const env = loadEnv();
  if (!isGoogleCalendarConfigured()) {
    throw new GoogleCalendarNotConfiguredError();
  }
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(env.GOOGLE_CALENDAR_CREDENTIALS_JSON);
  } catch (err) {
    throw new GoogleCalendarApiError(err, 'GOOGLE_CALENDAR_CREDENTIALS_JSON is not valid JSON');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new GoogleCalendarApiError(
      null,
      'GOOGLE_CALENDAR_CREDENTIALS_JSON missing client_email or private_key',
    );
  }
  cachedConfig = {
    credentials: {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
    },
    calendarIds: env.CALENDAR_IDS_TO_CHECK.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    primaryCalendarId: env.CALENDAR_PRIMARY.trim(),
  };
  return cachedConfig;
}

function getClient(): calendar_v3.Calendar {
  if (cachedClient) return cachedClient;
  const config = requireGoogleCalendarConfig();
  const auth = new JWT({
    email: config.credentials.client_email,
    key: config.credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  cachedClient = google.calendar({ version: 'v3', auth });
  return cachedClient;
}

export interface BusyInterval {
  startMs: number;
  endMs: number;
}

/**
 * Returns the union of all busy intervals across the configured calendars
 * inside [startMs, endMs]. Used by `findAvailableSlots()` to check candidate
 * 30-min slots against. The result is unsorted; the availability layer is the
 * one that intersects with candidate slots.
 */
export async function fetchBusyIntervals(input: {
  startMs: number;
  endMs: number;
}): Promise<BusyInterval[]> {
  const config = requireGoogleCalendarConfig();
  const client = getClient();
  try {
    const res = await client.freebusy.query({
      requestBody: {
        timeMin: new Date(input.startMs).toISOString(),
        timeMax: new Date(input.endMs).toISOString(),
        items: config.calendarIds.map((id) => ({ id })),
      },
    });
    const calendars = res.data.calendars ?? {};
    const intervals: BusyInterval[] = [];
    for (const calId of Object.keys(calendars)) {
      const cal = calendars[calId];
      if (cal?.errors && cal.errors.length > 0) {
        logger.warn(
          { calendarId: calId, errors: cal.errors },
          'google-calendar: freebusy reported errors for one calendar — skipping it (treating as no busy info)',
        );
        continue;
      }
      const busy = cal?.busy ?? [];
      for (const b of busy) {
        if (!b.start || !b.end) continue;
        const s = Date.parse(b.start);
        const e = Date.parse(b.end);
        if (Number.isNaN(s) || Number.isNaN(e)) continue;
        intervals.push({ startMs: s, endMs: e });
      }
    }
    return intervals;
  } catch (err) {
    throw new GoogleCalendarApiError(err, (err as Error).message);
  }
}

export interface CreateEventInput {
  /** Slot start (epoch ms). */
  startMs: number;
  /** Slot end (epoch ms). Usually startMs + 30 min. */
  endMs: number;
  summary: string;
  description?: string;
  /** Emails to invite (e.g. the customer's email + Guille's email). */
  attendeeEmails: string[];
}

export interface CreateEventResult {
  eventId: string;
  htmlLink: string;
  /** Generated Meet link. May be undefined if Meet creation failed. */
  meetLink?: string;
  startIso: string;
  endIso: string;
}

/**
 * Creates an event on the primary calendar with Google Meet auto-generated
 * via `conferenceData.createRequest`. Attendees receive Calendar invites
 * automatically (no manual email needed from us).
 */
export async function createCalendarEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const config = requireGoogleCalendarConfig();
  const client = getClient();
  try {
    const res = await client.events.insert({
      calendarId: config.primaryCalendarId,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      requestBody: {
        summary: input.summary,
        description: input.description,
        start: { dateTime: new Date(input.startMs).toISOString() },
        end: { dateTime: new Date(input.endMs).toISOString() },
        attendees: input.attendeeEmails.map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: `fama-${input.startMs}-${Math.random().toString(36).slice(2, 10)}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });
    const ev = res.data;
    if (!ev.id) {
      throw new GoogleCalendarApiError(null, 'event created without id');
    }
    const meetLink = ev.conferenceData?.entryPoints?.find(
      (ep) => ep.entryPointType === 'video',
    )?.uri;
    return {
      eventId: ev.id,
      htmlLink: ev.htmlLink ?? '',
      meetLink: meetLink ?? undefined,
      startIso: ev.start?.dateTime ?? new Date(input.startMs).toISOString(),
      endIso: ev.end?.dateTime ?? new Date(input.endMs).toISOString(),
    };
  } catch (err) {
    if (err instanceof GoogleCalendarApiError) throw err;
    throw new GoogleCalendarApiError(err, (err as Error).message);
  }
}

/**
 * Cancels an event on the primary calendar. Used as a defensive cleanup if
 * the post-booking sync (Twenty/Chatwoot) crashes catastrophically — the
 * agendador rolls back the event so the user doesn't have a phantom meeting.
 * Today (v3) we don't actually trigger this from the tool — leaving it
 * defined so a future iteration can wire it in without a new dep.
 */
export async function cancelCalendarEvent(eventId: string): Promise<void> {
  const config = requireGoogleCalendarConfig();
  const client = getClient();
  try {
    await client.events.delete({
      calendarId: config.primaryCalendarId,
      eventId,
      sendUpdates: 'all',
    });
  } catch (err) {
    throw new GoogleCalendarApiError(err, (err as Error).message);
  }
}
