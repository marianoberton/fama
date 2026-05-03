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
