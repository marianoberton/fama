import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_ID = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '7';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
});

const {
  setDedupStoreClientForTests,
  tryMarkProcessed,
  cleanupOldEntries,
  _truncateForTests,
} = await import('../../src/lib/dedup-store.js');

const T0 = Date.UTC(2026, 4, 4, 12, 0, 0);
const MIN = 60 * 1000;

beforeEach(async () => {
  const client = createClient({ url: ':memory:' });
  await setDedupStoreClientForTests(client);
  await _truncateForTests();
});

describe('dedup-store', () => {
  it('tryMarkProcessed returns true for a new messageId', async () => {
    const isNew = await tryMarkProcessed(1007, T0);
    expect(isNew).toBe(true);
  });

  it('tryMarkProcessed returns false on the second call with the same messageId', async () => {
    expect(await tryMarkProcessed(1007, T0)).toBe(true);
    expect(await tryMarkProcessed(1007, T0 + 1000)).toBe(false);
  });

  it('cleanupOldEntries deletes entries older than ttl, keeps recent ones', async () => {
    await tryMarkProcessed(1, T0 - 10 * MIN); // old
    await tryMarkProcessed(2, T0 - 6 * MIN); // old
    await tryMarkProcessed(3, T0 - 2 * MIN); // recent
    await tryMarkProcessed(4, T0); // recent

    const deleted = await cleanupOldEntries(5 * MIN, T0);
    expect(deleted).toBe(2);

    // After cleanup, the deleted ids are claimable again; the recent ones still aren't.
    expect(await tryMarkProcessed(1, T0)).toBe(true);
    expect(await tryMarkProcessed(3, T0)).toBe(false);
    expect(await tryMarkProcessed(4, T0)).toBe(false);
  });

  it('two concurrent tryMarkProcessed for the same id — exactly one returns true', async () => {
    const [a, b] = await Promise.all([
      tryMarkProcessed(2024, T0),
      tryMarkProcessed(2024, T0),
    ]);
    expect([a, b].filter((x) => x === true).length).toBe(1);
    expect([a, b].filter((x) => x === false).length).toBe(1);
  });
});
