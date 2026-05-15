/**
 * Diagnostica si el calendar de Guille es accesible desde el SA impersonando a Mariano.
 *
 * Muestra:
 *   1. Los calendars a los que Mariano tiene acceso (calendarList)
 *   2. La respuesta cruda de freebusy para guille@fomo.com.ar
 *      (si retorna notFound, el email es incorrecto o no hay sharing interno)
 *
 * Correr con:
 *   npx -y tsx --env-file=.env scripts/check-guille-calendar.ts
 */

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { loadEnv } from '../src/config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();

  if (!env.GOOGLE_CALENDAR_CREDENTIALS_JSON || !env.CALENDAR_PRIMARY) {
    console.error('FAIL: GOOGLE_CALENDAR_CREDENTIALS_JSON o CALENDAR_PRIMARY no están en .env');
    process.exit(1);
  }

  const creds = JSON.parse(env.GOOGLE_CALENDAR_CREDENTIALS_JSON) as {
    client_email: string;
    private_key: string;
  };

  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
    subject: env.CALENDAR_PRIMARY,
  });

  const cal = google.calendar({ version: 'v3', auth });

  // 1. Listar todos los calendars que Mariano puede ver
  console.log(`\n[1] Calendars visibles para ${env.CALENDAR_PRIMARY}:\n`);
  const list = await cal.calendarList.list();
  for (const item of list.data.items ?? []) {
    console.log(`  ${item.accessRole?.padEnd(12)} ${item.id}  (${item.summary})`);
  }

  // 2. Freebusy raw para todos los IDs configurados
  const calendarIds = env.CALENDAR_IDS_TO_CHECK.split(',').map((s) => s.trim());
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  console.log(`\n[2] Freebusy crudo para: ${calendarIds.join(', ')}\n`);
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    },
  });

  for (const [id, data] of Object.entries(res.data.calendars ?? {})) {
    if (data.errors && data.errors.length > 0) {
      console.log(`  ❌ ${id}`);
      for (const e of data.errors) {
        console.log(`     error: ${e.domain} / ${e.reason}`);
      }
    } else {
      const busyCount = data.busy?.length ?? 0;
      console.log(`  ✅ ${id}  →  ${busyCount} evento(s) ocupado(s) en las próximas 48hs`);
    }
  }

  console.log('\nSi ves ❌ notFound para guille@fomo.com.ar:');
  console.log('  → el email puede ser otro alias (guillermina@fomo.com.ar, etc.)');
  console.log('  → o Guille no compartió su calendar con Mariano internamente en el Workspace');
  console.log('\nSi ves ✅ para guille@fomo.com.ar: el calendar funciona, podés commitear CLAUDE.md con ese email confirmado.');
}

main().catch((err) => {
  console.error('FAIL:', (err as Error).message);
  process.exit(1);
});
