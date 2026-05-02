/**
 * Pure filter for incoming Chatwoot webhooks.
 *
 * Implements the 6 rules from CLAUDE.md ("Filtrado obligatorio del webhook")
 * in the exact order documented there. No side effects, no env access — the
 * caller passes everything in.
 */

export type FilterResult =
  | { pass: true }
  | { pass: false; status: 200 | 401; reason: string };

export interface FilterInput {
  pathToken: string;
  body: unknown;
  expectedAccountId: number;
  expectedPathToken: string;
}

export function filterWebhook(input: FilterInput): FilterResult {
  const { pathToken, body, expectedAccountId, expectedPathToken } = input;

  // Rule 1 — invalid path token → 401
  if (
    typeof pathToken !== 'string' ||
    pathToken.length === 0 ||
    pathToken !== expectedPathToken
  ) {
    return { pass: false, status: 401, reason: 'invalid_path_token' };
  }

  if (!isObject(body)) {
    return { pass: false, status: 401, reason: 'invalid_body_shape' };
  }

  // Rule 2 — account id mismatch → 401
  const account = (body as Record<string, unknown>)['account'];
  const accountId = isObject(account)
    ? (account as Record<string, unknown>)['id']
    : undefined;
  if (typeof accountId !== 'number' || accountId !== expectedAccountId) {
    return { pass: false, status: 401, reason: 'account_mismatch' };
  }

  // Rule 3 — event !== 'message_created' → 200 silent
  const event = (body as Record<string, unknown>)['event'];
  if (event !== 'message_created') {
    return { pass: false, status: 200, reason: 'event_not_message_created' };
  }

  const message = pickFirstMessage(body);

  // Rule 4 — message_type !== 0 (incoming) → 200 silent
  const messageType = isObject(message)
    ? (message as Record<string, unknown>)['message_type']
    : undefined;
  if (messageType !== 0) {
    return { pass: false, status: 200, reason: 'message_type_not_incoming' };
  }

  // Rule 5 — sender.type !== 'contact' → 200 silent
  const sender = (message as Record<string, unknown>)['sender'];
  const senderType = isObject(sender)
    ? (sender as Record<string, unknown>)['type']
    : undefined;
  if (senderType !== 'contact') {
    return { pass: false, status: 200, reason: 'sender_not_contact' };
  }

  // Rule 6 — empty / whitespace-only content → 200 silent
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { pass: false, status: 200, reason: 'empty_content' };
  }

  return { pass: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickFirstMessage(body: unknown): unknown {
  if (!isObject(body)) return undefined;
  const messages = (body as Record<string, unknown>)['messages'];
  if (Array.isArray(messages)) return messages[0];
  // Some Chatwoot events deliver the message inline rather than under
  // `messages[0]`. CLAUDE.md only mentions `messages?.[0]`, so we stick to that.
  return undefined;
}
