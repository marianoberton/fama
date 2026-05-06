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

  // Real Chatwoot v4.12.1 payload: messages array nested under `conversation`,
  // root `sender` has NO `type` field, root `message_type` is the string
  // 'incoming'. Filter must pick the message from conversation.messages[0]
  // (where message_type IS 0 and sender.type IS 'contact'). Without this
  // path, every real webhook gets ignored as message_type_not_incoming.
  it('chatwoot v4.12.1 nested shape: passes by reading conversation.messages[0]', () => {
    const { body } = loadFixture('08-happy-path-v4-12.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({ pass: true });
  });

  // Sprint 2: media-only messages (audio/image without text) must pass even
  // though `content` is empty — the multimodal pre-processor enriches them
  // downstream. Videos and other unsupported types are still rejected.
  it('audio-only attachment + empty content → passes (rule 6 lets media through)', () => {
    const { body } = loadFixture('09-audio-attachment.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({ pass: true });
  });

  it('image with caption text → passes', () => {
    const { body } = loadFixture('10-image-with-caption.json');
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({ pass: true });
  });

  it('video-only attachment + empty content → still rejected (unsupported)', () => {
    const { body } = loadFixture('11-video-only.json');
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
});

// Rule 7 — once a human takes over (status=open) the bot must stop responding.
// Same for resolved/snoozed. Only `pending` lets the bot process. The body
// shape mirrors Chatwoot v4.12.1 (conversation.messages, no root messages).
describe('filterWebhook — rule 7: conversation status', () => {
  function buildV412Body(status: string): Record<string, unknown> {
    return {
      account: { id: EXPECTED_ACCOUNT_ID, name: 'fomo' },
      content: 'hola',
      content_type: 'text',
      conversation: {
        id: 8,
        inbox_id: 3,
        status,
        messages: [
          {
            id: 76,
            content: 'hola',
            message_type: 0,
            private: false,
            sender: {
              id: 2,
              type: 'contact',
              name: 'Mariano',
              phone_number: '+5491132766709',
            },
          },
        ],
      },
      id: 76,
      inbox: { id: 3, name: 'Fomo Contacto' },
      message_type: 'incoming',
      private: false,
      sender: { id: 2, name: 'Mariano' },
      event: 'message_created',
    };
  }

  it('status=open (human took over) → 200 ignored conversation_not_pending', () => {
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body: buildV412Body('open'),
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'conversation_not_pending',
    });
  });

  it('status=resolved (closed) → 200 ignored conversation_not_pending', () => {
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body: buildV412Body('resolved'),
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'conversation_not_pending',
    });
  });

  it('status=snoozed (paused) → 200 ignored conversation_not_pending', () => {
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body: buildV412Body('snoozed'),
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'conversation_not_pending',
    });
  });

  it('status=pending → passes through to remaining rules', () => {
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body: buildV412Body('pending'),
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({ pass: true });
  });

  it('missing conversation.status → rejected as conversation_not_pending (fail-safe)', () => {
    // If status is missing for whatever reason, default to ignoring rather
    // than risking the bot replying on a conversation it shouldn't own.
    const body = buildV412Body('pending');
    delete (body.conversation as Record<string, unknown>).status;
    const result = filterWebhook({
      pathToken: EXPECTED_TOKEN,
      body,
      expectedAccountId: EXPECTED_ACCOUNT_ID,
      expectedPathToken: EXPECTED_TOKEN,
    });
    expect(result).toEqual({
      pass: false,
      status: 200,
      reason: 'conversation_not_pending',
    });
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
        // conversation present with status=pending so rule 7 passes; the
        // empty messages array is what should trigger rule 4.
        conversation: { status: 'pending' },
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
