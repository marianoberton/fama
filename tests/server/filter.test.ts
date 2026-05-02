import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterWebhook } from '../../src/server/filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'webhook');

const EXPECTED_TOKEN = 'expected-test-path-token';
const EXPECTED_ACCOUNT_ID = 1;

function loadFixture(name: string): {
  body: Record<string, unknown>;
  meta: { pathToken?: string };
} {
  const raw = readFileSync(path.join(fixturesDir, name), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const meta = (parsed['_meta'] as { pathToken?: string } | undefined) ?? {};
  // Strip _meta so the body resembles a real Chatwoot payload.
  const body: Record<string, unknown> = { ...parsed };
  delete body['_meta'];
  return { body, meta };
}

describe('filterWebhook — 6 rules from CLAUDE.md', () => {
  it('rule 1: invalid path token → 401', () => {
    const { body, meta } = loadFixture('01-invalid-path-token.json');
    const result = filterWebhook({
      pathToken: meta.pathToken ?? 'wrong',
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 401,
      reason: 'invalid_path_token',
    });
  });

  it('rule 2: account.id mismatch → 401', () => {
    const { body } = loadFixture('02-account-mismatch.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 401,
      reason: 'account_mismatch',
    });
  });

  it('rule 3: event !== message_created → 200 silent', () => {
    const { body } = loadFixture('03-event-not-message-created.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'event_not_message_created',
    });
  });

  it('rule 4: message_type !== 0 → 200 silent', () => {
    const { body } = loadFixture('04-message-type-not-incoming.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'message_type_not_incoming',
    });
  });

  it('rule 5: sender.type !== contact → 200 silent', () => {
    const { body } = loadFixture('05-sender-not-contact.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'sender_not_contact',
    });
  });

  it('rule 6: whitespace-only content → 200 silent', () => {
    const { body } = loadFixture('06-empty-content.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'empty_content',
    });
  });

  it('happy path: incoming message from contact passes', () => {
    const { body } = loadFixture('07-happy-path.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({ pass: true });
  });
});

describe('filterWebhook — defensive shape checks', () => {
  it('rejects non-object body with 401', () => {
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body: 'not an object',
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result.pass).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it('rejects null body with 401', () => {
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body: null,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result.pass).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it('treats missing messages[0] as not-incoming (rule 4) → 200', () => {
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body: {
        event: 'message_created',
        account: { id: EXPECTED_ACCOUNT_ID },
        messages: [],
      },
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'message_type_not_incoming',
    });
  });

  it('rule order: invalid token wins over everything else', () => {
    const result = filterWebhook({
      pathToken: 'nope',
      body: { event: 'whatever', account: { id: 999 } },
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toMatchObject({
      pass: false,
      status: 401,
      reason: 'invalid_path_token',
    });
  });
});
