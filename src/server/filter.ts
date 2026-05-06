/**
 * Pure filter for incoming Chatwoot webhooks.
 *
 * Implements the 7 rules from CLAUDE.md ("Filtrado obligatorio del webhook")
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

  // Rule 7 (added) — conversation.status !== 'pending' → 200 silent. Once a
  // human takes over a conversation, Chatwoot flips the status from 'pending'
  // to 'open'; the bot must stop responding so it doesn't talk over the
  // human. Same applies to 'resolved' (closed) and 'snoozed' (paused).
  // Reactivating the bot is a manual action: an agent flips the status back
  // to 'pending' from the conversation header dropdown in the Chatwoot UI.
  const conversation = (body as Record<string, unknown>)['conversation'];
  const conversationStatus = isObject(conversation)
    ? (conversation as Record<string, unknown>)['status']
    : undefined;
  if (conversationStatus !== 'pending') {
    return { pass: false, status: 200, reason: 'conversation_not_pending' };
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

  // Rule 6 — empty / whitespace-only content → 200 silent, UNLESS the message
  // carries supported media attachments (audio or image). Sprint 2 v2 adds
  // multimodal pre-processing: WhatsApp audios and images arrive with empty
  // `content` and the actual payload in `attachments[]` — we want those to
  // pass and reach the attachment-processor downstream.
  const content = (message as Record<string, unknown>)['content'];
  const contentEmpty = typeof content !== 'string' || content.trim().length === 0;
  if (contentEmpty && !hasSupportedMediaAttachment(message)) {
    return { pass: false, status: 200, reason: 'empty_content' };
  }

  return { pass: true };
}

/**
 * Returns true if the message has at least one supported media attachment
 * (audio or image). Used by Rule 6 to let media-only messages pass even when
 * `content` is empty.
 */
function hasSupportedMediaAttachment(message: unknown): boolean {
  if (!isObject(message)) return false;
  const attachments = (message as Record<string, unknown>)['attachments'];
  if (!Array.isArray(attachments)) return false;
  for (const a of attachments) {
    if (!isObject(a)) continue;
    const fileType = (a as Record<string, unknown>)['file_type'];
    if (typeof fileType !== 'string') continue;
    const lc = fileType.toLowerCase();
    if (lc === 'audio' || lc === 'image') return true;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickFirstMessage(body: unknown): unknown {
  if (!isObject(body)) return undefined;
  // Chatwoot v4.12.1 nests the messages array inside `conversation`. Older /
  // alternate event shapes deliver it at the root — keep that as fallback.
  const conversation = (body as Record<string, unknown>)['conversation'];
  if (isObject(conversation)) {
    const nested = (conversation as Record<string, unknown>)['messages'];
    if (Array.isArray(nested) && nested.length > 0) return nested[0];
  }
  const rootMessages = (body as Record<string, unknown>)['messages'];
  if (Array.isArray(rootMessages)) return rootMessages[0];
  return undefined;
}
