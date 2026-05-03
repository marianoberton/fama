import { loadEnv } from '../config/env.js';

export class ChatwootNotConfiguredError extends Error {
  constructor() {
    super(
      'CHATWOOT_API_TOKEN is empty — set it in .env to enable outbound Chatwoot API calls',
    );
    this.name = 'ChatwootNotConfiguredError';
  }
}

export class ChatwootApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly bodyPreview: string,
  ) {
    super(`Chatwoot API error: ${status} ${statusText} — ${bodyPreview.slice(0, 300)}`);
    this.name = 'ChatwootApiError';
  }
}

export function requireChatwootToken(): string {
  const env = loadEnv();
  if (!env.CHATWOOT_API_TOKEN) {
    throw new ChatwootNotConfiguredError();
  }
  return env.CHATWOOT_API_TOKEN;
}

async function chatwootPost(input: {
  conversationId: number;
  path: 'labels' | 'messages' | 'assignments' | 'toggle_status';
  body: unknown;
}): Promise<unknown> {
  const env = loadEnv();
  const token = requireChatwootToken();

  const url = `${env.CHATWOOT_BASE_URL}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${input.conversationId}/${input.path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      api_access_token: token,
    },
    body: JSON.stringify(input.body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ChatwootApiError(res.status, res.statusText, text);
  }

  return res.json().catch(() => ({}));
}

async function chatwootGet(input: {
  conversationId: number;
}): Promise<Record<string, unknown>> {
  const env = loadEnv();
  const token = requireChatwootToken();

  const url = `${env.CHATWOOT_BASE_URL}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${input.conversationId}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { api_access_token: token },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ChatwootApiError(res.status, res.statusText, text);
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return json;
}

export interface ChatwootConversationSummary {
  id: number;
  inboxId: number;
  messageCount: number;
  /** Epoch ms of last_activity_at (or created_at as fallback). */
  lastActivityAtMs: number;
}

/**
 * Lists all conversations for a contact, normalised to the fields the
 * known-customer detector needs. Used by the webhook handler to decide if a
 * client is returning (skip welcome → go to LLM with prior-context).
 *
 * Defaults to a 3s timeout. On timeout, throws a DOMException with name
 * 'AbortError'. The caller is responsible for fail-closed handling — any
 * error means "treat as unknown and proceed with normal flow".
 */
export async function getContactConversations(input: {
  contactId: number;
  timeoutMs?: number;
}): Promise<ChatwootConversationSummary[]> {
  const env = loadEnv();
  const token = requireChatwootToken();
  const timeoutMs = input.timeoutMs ?? 3000;
  const url = `${env.CHATWOOT_BASE_URL}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/contacts/${input.contactId}/conversations`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { api_access_token: token },
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ChatwootApiError(res.status, res.statusText, text);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = pickConversationArray(json);
    return raw
      .map(parseConversationSummary)
      .filter((c): c is ChatwootConversationSummary => c !== null);
  } finally {
    clearTimeout(timer);
  }
}

function pickConversationArray(json: Record<string, unknown>): unknown[] {
  if (Array.isArray(json)) return json;
  const payload = json['payload'];
  if (Array.isArray(payload)) return payload;
  // Some Chatwoot versions wrap the list under data.payload.
  const data = json['data'];
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>)['payload'];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

function parseConversationSummary(raw: unknown): ChatwootConversationSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'number' ? o['id'] : null;
  const inboxId = typeof o['inbox_id'] === 'number' ? o['inbox_id'] : null;
  if (id === null || inboxId === null) return null;

  const messages = Array.isArray(o['messages']) ? o['messages'] : [];
  const messageCount =
    typeof o['messages_count'] === 'number' ? o['messages_count'] : messages.length;

  const lastActivityAtMs = pickEpochMs(o['last_activity_at']) ?? pickEpochMs(o['created_at']);
  if (lastActivityAtMs === null) return null;

  return { id, inboxId, messageCount, lastActivityAtMs };
}

function pickEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Chatwoot returns epoch seconds; treat anything below 10^12 as seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export type ChatwootConversationStatus = 'pending' | 'open' | 'resolved' | 'snoozed';

/**
 * Returns the conversation's current status. Used by the NURTURING worker to
 * skip conversations a human has picked up (status === 'open') even if our
 * local store hasn't been updated yet.
 */
export async function getChatwootConversationStatus(
  conversationId: number,
): Promise<ChatwootConversationStatus> {
  const json = await chatwootGet({ conversationId });
  const status = json['status'];
  if (status === 'pending' || status === 'open' || status === 'resolved' || status === 'snoozed') {
    return status;
  }
  // Unknown statuses default to 'open' (safer — worker will skip).
  return 'open';
}

export interface SendMessageInput {
  conversationId: number;
  content: string;
  /** When true, posts as a private note (only visible to agents in Chatwoot). */
  private?: boolean;
}

export async function sendChatwootMessage(input: SendMessageInput): Promise<void> {
  await chatwootPost({
    conversationId: input.conversationId,
    path: 'messages',
    body: {
      content: input.content,
      message_type: 'outgoing',
      private: input.private ?? false,
    },
  });
}

export async function addChatwootLabels(input: {
  conversationId: number;
  labels: string[];
}): Promise<void> {
  await chatwootPost({
    conversationId: input.conversationId,
    path: 'labels',
    body: { labels: input.labels },
  });
}

export async function assignChatwootTeam(input: {
  conversationId: number;
  teamId: number;
}): Promise<void> {
  await chatwootPost({
    conversationId: input.conversationId,
    path: 'assignments',
    body: { team_id: input.teamId },
  });
}

export async function toggleChatwootStatus(input: {
  conversationId: number;
  status: 'open' | 'resolved' | 'pending';
}): Promise<void> {
  await chatwootPost({
    conversationId: input.conversationId,
    path: 'toggle_status',
    body: { status: input.status },
  });
}
