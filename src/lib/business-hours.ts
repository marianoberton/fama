/**
 * Argentina business hours helpers.
 *
 * Argentina uses UTC-3 year-round (no DST since 2009), so we don't need a TZ
 * library — a fixed offset is correct. The window is [9:00, 19:00) local AR
 * (i.e. 9:00 inclusive, 19:00 exclusive — 18:59 still counts, 19:00 does not).
 *
 * "Business hours" applies to NURTURING outbound messages: we never send a
 * follow-up outside this window even if the timing math says so.
 */

const AR_OFFSET_HOURS = -3;
const WINDOW_START_HOUR = 9; // inclusive
const WINDOW_END_HOUR = 19; // exclusive

function argentinaHour(date: Date): number {
  // UTC hour + offset, wrapped 0-23.
  return (date.getUTCHours() + AR_OFFSET_HOURS + 24) % 24;
}

export function isInArgentinaBusinessHours(date: Date): boolean {
  const h = argentinaHour(date);
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

/**
 * Returns the next moment >= `from` that falls inside the business window.
 * If `from` is already inside, returns `from` unchanged. Otherwise jumps to
 * the next 9:00 AR (today or tomorrow depending on hour).
 *
 * Used by the worker for log/telemetry: "deferring retry until X". The actual
 * scheduling is just "skip this tick" — we re-evaluate every interval.
 */
export function nextArgentinaBusinessTime(from: Date): Date {
  if (isInArgentinaBusinessHours(from)) return new Date(from.getTime());

  const out = new Date(from.getTime());
  // Move to next 9:00 AR. AR 9:00 == UTC 12:00.
  const targetUTCHour = WINDOW_START_HOUR - AR_OFFSET_HOURS; // 12
  const currentUTCHour = out.getUTCHours();

  if (currentUTCHour < targetUTCHour) {
    out.setUTCHours(targetUTCHour, 0, 0, 0);
  } else {
    // Tomorrow at 9:00 AR
    out.setUTCDate(out.getUTCDate() + 1);
    out.setUTCHours(targetUTCHour, 0, 0, 0);
  }
  return out;
}
