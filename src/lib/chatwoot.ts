import { loadEnv } from '../config/env.js';

export class ChatwootNotConfiguredError extends Error {
  constructor() {
    super(
      'CHATWOOT_API_TOKEN is empty — set it in .env to enable outbound Chatwoot API calls',
    );
    this.name = 'ChatwootNotConfiguredError';
  }
}

export function requireChatwootToken(): string {
  const env = loadEnv();
  if (!env.CHATWOOT_API_TOKEN) {
    throw new ChatwootNotConfiguredError();
  }
  return env.CHATWOOT_API_TOKEN;
}

export interface SendMessageInput {
  conversationId: number;
  content: string;
  /** When true, posts as a private note (only visible to agents in Chatwoot). */
  private?: boolean;
}

export async function sendChatwootMessage(input: SendMessageInput): Promise<void> {
  const env = loadEnv();
  const token = requireChatwootToken();

  const url = `${env.CHATWOOT_BASE_URL}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${input.conversationId}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      api_access_token: token,
    },
    body: JSON.stringify({
      content: input.content,
      message_type: 'outgoing',
      private: input.private ?? false,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Chatwoot sendMessage failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`,
    );
  }
}
