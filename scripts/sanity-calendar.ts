/**
 * Sanity end-to-end del Sprint 3 — verifica que la auth con el service account
 * funciona, lee el freebusy real de los calendars compartidos, y crea + borra
 * un evento de prueba para confirmar que el SA tiene permisos de escritura.
 *
 * Correr con:
 *   npx -y tsx --env-file=.env scripts/sanity-calendar.ts
 *
 * Si pasa los 4 pasos sin error, el setup de GCP está OK y el agendador puede
 * empezar a coordinar demos reales.
 */

import {
  isGoogleCalendarConfigured,
  fetchBusyIntervals,
  createCalendarEvent,
  cancelCalendarEvent,
  requireGoogleCalendarConfig,
} from '../src/lib/google-calendar.js';
import {
  findAvailableSlots,
  formatSlotForHumans,
} from '../src/lib/availability.js';

async function main(): Promise<void> {
  console.log('=== FAMA Calendar Sanity ===\n');

  if (!isGoogleCalendarConfigured()) {
    console.error(
      'FAIL: GOOGLE_CALENDAR_CREDENTIALS_JSON / CALENDAR_IDS_TO_CHECK / CALENDAR_PRIMARY missing in .env',
    );
    process.exit(1);
  }
  const config = requireGoogleCalendarConfig();
  console.log('[OK] config loaded');
  console.log('  SA email:', config.credentials.client_email);
  console.log('  calendars to check:', config.calendarIds.join(', '));
  console.log('  primary calendar:', config.primaryCalendarId);

  // 1. Free/busy across all configured calendars in the next 7 days.
  const now = Date.now();
  const lookaheadMs = 8 * 24 * 60 * 60 * 1000;
  console.log('\n[1] fetching busy intervals for next 7 days...');
  const busy = await fetchBusyIntervals({ startMs: now, endMs: now + lookaheadMs });
  console.log(`[OK] ${busy.length} busy intervals found`);
  if (busy.length > 0) {
    console.log('  first 3:');
    for (const b of busy.slice(0, 3)) {
      console.log(
        `    ${new Date(b.startMs).toISOString()}  →  ${new Date(b.endMs).toISOString()}`,
      );
    }
  } else {
    console.log('  (calendars are completely free — unusual, double-check auth worked)');
  }

  // 2. Compute the next 2 free slots respecting AR business hours + buffer.
  console.log('\n[2] computing next 2 free slots (AR 9-19hs, 30min, 15min buffer, no same-day)...');
  const slots = findAvailableSlots({ nowMs: now, busy, count: 2 });
  if (slots.length === 0) {
    console.error('FAIL: no free slots — calendars might be fully booked or auth silently failed');
    process.exit(1);
  }
  for (const s of slots) {
    console.log(
      `  - ${formatSlotForHumans(s)}  (epoch start ${s.startMs}, ISO ${new Date(
        s.startMs,
      ).toISOString()})`,
    );
  }

  // 3. Create a test event in the first free slot. Empty attendees so it
  //    only goes on the primary calendar — no inviting Guille for sanity.
  const firstSlot = slots[0]!;
  console.log('\n[3] creating test event in first free slot...');
  const event = await createCalendarEvent({
    startMs: firstSlot.startMs,
    endMs: firstSlot.endMs,
    summary: 'FAMA SANITY — DELETE ME',
    description:
      'Evento de prueba generado por scripts/sanity-calendar.ts.\n' +
      'Si lo ves en tu Calendar, FAMA logró escribir. El script lo borra solo en el siguiente paso.',
    attendeeEmails: [],
  });
  console.log('[OK] event created');
  console.log('  eventId :', event.eventId);
  console.log('  meetLink:', event.meetLink ?? '(no Meet link generated)');
  console.log('  htmlLink:', event.htmlLink);
  console.log('  start   :', event.startIso);
  console.log('  end     :', event.endIso);

  // 4. Cleanup — delete the test event.
  console.log('\n[4] cleaning up — deleting test event...');
  await cancelCalendarEvent(event.eventId);
  console.log('[OK] event deleted');

  console.log('\n=== ALL OK — agendador can book real demos ===');
}

main().catch((err) => {
  console.error('\nSANITY FAILED');
  console.error('  message:', (err as Error).message);
  if ((err as Error).stack) console.error('  stack:', (err as Error).stack);
  process.exit(1);
});
