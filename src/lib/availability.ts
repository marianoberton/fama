/**
 * Pure availability logic: given busy intervals and a clock, produce a list
 * of candidate 30-min slots that respect Argentine business hours, weekend
 * exclusion, the "no same-day" rule, and a configurable buffer.
 *
 * No I/O, no env access — `findAvailableSlots()` takes a clock injection so
 * tests can pin "now" deterministically. The Google Calendar layer feeds the
 * busy intervals from `freebusy.query`.
 *
 * Argentina has no DST since 2019 → fixed UTC-3 offset. We treat that as a
 * constant; if Argentina ever brings DST back, this is the only place to fix.
 */

import type { BusyInterval } from './google-calendar.js';

export const AR_OFFSET_HOURS = 3;
const AR_OFFSET_MS = AR_OFFSET_HOURS * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

export const SLOT_DURATION_MIN = 30;
export const BUFFER_MIN = 15;
export const BUSINESS_START_HOUR_AR = 9;
export const BUSINESS_END_HOUR_AR = 19;
export const WINDOW_DAYS = 7;
export const DEFAULT_SLOTS_OFFERED = 2;

export interface SlotCandidate {
  startMs: number;
  endMs: number;
}

/** Date components in Argentine local clock (UTC-3). */
interface ARDateParts {
  year: number;
  monthIndex: number; // 0-11
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun .. 6=Sat
}

function arPartsFromEpoch(epochMs: number): ARDateParts {
  const shifted = epochMs - AR_OFFSET_MS;
  const d = new Date(shifted);
  return {
    year: d.getUTCFullYear(),
    monthIndex: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

function arEpoch(year: number, monthIndex: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, monthIndex, day, hour, minute) + AR_OFFSET_MS;
}

/**
 * Returns epoch ms for tomorrow at 9 AM AR (the earliest slot we ever offer).
 * Saturday/Sunday roll forward to Monday.
 */
export function startOfNextBusinessDay(nowMs: number): number {
  const today = arPartsFromEpoch(nowMs);
  // Add one day in AR clock, anchored at 9 AM.
  let candidate = arEpoch(today.year, today.monthIndex, today.day + 1, BUSINESS_START_HOUR_AR, 0);
  // Skip weekend (0=Sun, 6=Sat) by rolling forward.
  for (let safety = 0; safety < 10; safety++) {
    const wd = arPartsFromEpoch(candidate).weekday;
    if (wd !== 0 && wd !== 6) return candidate;
    const parts = arPartsFromEpoch(candidate);
    candidate = arEpoch(parts.year, parts.monthIndex, parts.day + 1, BUSINESS_START_HOUR_AR, 0);
  }
  // Cannot happen in normal calendars — defensive return.
  return candidate;
}

/**
 * Generates ALL 30-min candidate slots in the search window — without yet
 * checking busy intervals. The window starts at `startOfNextBusinessDay` and
 * spans `windowDays` calendar days, skipping weekends, restricted to AR
 * business hours.
 */
export function generateCandidateSlots(input: {
  nowMs: number;
  windowDays?: number;
}): SlotCandidate[] {
  const windowDays = input.windowDays ?? WINDOW_DAYS;
  const earliest = startOfNextBusinessDay(input.nowMs);
  const slots: SlotCandidate[] = [];

  for (let d = 0; d < windowDays; d++) {
    const earliestParts = arPartsFromEpoch(earliest);
    const dayStart = arEpoch(
      earliestParts.year,
      earliestParts.monthIndex,
      earliestParts.day + d,
      BUSINESS_START_HOUR_AR,
      0,
    );
    const wd = arPartsFromEpoch(dayStart).weekday;
    if (wd === 0 || wd === 6) continue;
    const businessHours = BUSINESS_END_HOUR_AR - BUSINESS_START_HOUR_AR;
    // Last slot starts so it ENDS exactly at BUSINESS_END_HOUR_AR.
    for (let mins = 0; mins + SLOT_DURATION_MIN <= businessHours * 60; mins += SLOT_DURATION_MIN) {
      const startMs = dayStart + mins * MIN_MS;
      const endMs = startMs + SLOT_DURATION_MIN * MIN_MS;
      slots.push({ startMs, endMs });
    }
  }
  return slots;
}

/**
 * Returns true if [startMs, endMs] (extended by `bufferMs` on both sides)
 * does NOT intersect any busy interval. The busy list does not need to be
 * sorted or merged — we walk it linearly.
 */
export function isSlotFree(input: {
  slot: SlotCandidate;
  busy: BusyInterval[];
  bufferMs: number;
}): boolean {
  const slotStart = input.slot.startMs - input.bufferMs;
  const slotEnd = input.slot.endMs + input.bufferMs;
  for (const b of input.busy) {
    if (slotStart < b.endMs && slotEnd > b.startMs) return false;
  }
  return true;
}

/**
 * Returns true if `slotStartMs` is one of the timestamps that
 * `generateCandidateSlots()` would emit for the search window starting at
 * `nowMs`. Used by `book-calendar-event` to defend against the LLM
 * hallucinating an arbitrary epoch ms that isn't on the offered grid.
 *
 * Constraints checked:
 *   - Slot is on the half-hour grid (minute is 00 or 30).
 *   - Slot starts >= 9:00 AR and ends <= 19:00 AR (business hours).
 *   - Day is Monday–Friday (no weekends).
 *   - Slot is at-or-after `startOfNextBusinessDay(nowMs)` (no same-day, no past).
 *   - When `windowDays` is provided, the slot is within that window.
 *     book-calendar-event leaves it undefined so it can accept slots beyond 7
 *     days if a future iteration of list-calendar-slots returns them; tests
 *     pass it to assert window bounds.
 */
export function isSlotOnCandidateGrid(input: {
  slotStartMs: number;
  nowMs: number;
  windowDays?: number;
}): boolean {
  const earliest = startOfNextBusinessDay(input.nowMs);
  if (input.slotStartMs < earliest) return false;
  if (input.windowDays !== undefined) {
    const latest =
      earliest + input.windowDays * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;
    if (input.slotStartMs >= latest) return false;
  }

  const parts = arPartsFromEpoch(input.slotStartMs);
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  if (parts.hour < BUSINESS_START_HOUR_AR) return false;
  // Last legal slot starts at (BUSINESS_END_HOUR_AR - 0.5h). After that the
  // 30-min slot would end past 19:00.
  const slotStartHourAR = parts.hour + parts.minute / 60;
  if (slotStartHourAR + SLOT_DURATION_MIN / 60 > BUSINESS_END_HOUR_AR) return false;
  // Aligned to half-hour grid (0 or 30 min).
  if (parts.minute !== 0 && parts.minute !== 30) return false;
  return true;
}

export interface FindSlotsInput {
  nowMs: number;
  busy: BusyInterval[];
  /** How many free slots to return. Default 2 (Sprint 3 design). */
  count?: number;
  /** Buffer around each slot in MINUTES. Default 15. */
  bufferMin?: number;
  /** Search-window length in days. Default 7. */
  windowDays?: number;
}

/**
 * Main entry point. Returns the first N slots, in chronological order, that
 * don't collide with any busy interval after applying buffer.
 *
 * Strategy: brute-force over all candidate slots. Even for a 7-day window
 * with 20 slots/day that's only 100 candidates — no need for clever data
 * structures.
 */
export function findAvailableSlots(input: FindSlotsInput): SlotCandidate[] {
  const candidates = generateCandidateSlots({
    nowMs: input.nowMs,
    windowDays: input.windowDays ?? WINDOW_DAYS,
  });
  const bufferMs = (input.bufferMin ?? BUFFER_MIN) * MIN_MS;
  const count = input.count ?? DEFAULT_SLOTS_OFFERED;
  const result: SlotCandidate[] = [];
  for (const slot of candidates) {
    if (isSlotFree({ slot, busy: input.busy, bufferMs })) {
      result.push(slot);
      if (result.length >= count) break;
    }
  }
  return result;
}

/**
 * Renders a slot in human-readable Argentine format, e.g.
 *   "miércoles 7 de mayo a las 11:00hs"
 * Used by the agendador prompt to offer slots verbally to the customer.
 */
export function formatSlotForHumans(slot: SlotCandidate): string {
  const parts = arPartsFromEpoch(slot.startMs);
  const weekdayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const monthNames = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  const hh = parts.hour.toString().padStart(2, '0');
  const mm = parts.minute.toString().padStart(2, '0');
  return `${weekdayNames[parts.weekday]} ${parts.day} de ${monthNames[parts.monthIndex]} a las ${hh}:${mm}hs`;
}

/** Converts a slot back into ISO strings for logging / Twenty notes. */
export function slotToIso(slot: SlotCandidate): { startIso: string; endIso: string } {
  return {
    startIso: new Date(slot.startMs).toISOString(),
    endIso: new Date(slot.endMs).toISOString(),
  };
}
