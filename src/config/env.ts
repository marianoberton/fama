import { z } from 'zod';

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),

  CHATWOOT_BASE_URL: z.string().url(),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
  // Comma-separated list of Chatwoot inbox IDs managed by FAMA (e.g. "3,5").
  // Supports multiple inboxes so FAMA can handle both WhatsApp and web chat
  // (Elena product foundation). The webhook filter does NOT gate by inbox_id —
  // all inboxes connected to the agent bot pass through. Workers (auto-handback,
  // nurturing) and known-customer detection use this list to scope their queries.
  CHATWOOT_INBOX_IDS: z
    .string()
    .min(1, 'CHATWOOT_INBOX_IDS is required (e.g. "3" or "3,5")')
    .transform((s) =>
      s
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0),
    )
    .refine((ids) => ids.length > 0, 'CHATWOOT_INBOX_IDS must contain at least one valid inbox ID'),
  CHATWOOT_AGENT_BOT_ID: z.coerce.number().int().positive(),
  CHATWOOT_TEAM_ID: z.coerce.number().int().positive(),
  CHATWOOT_PATH_TOKEN: z.string().min(1, 'CHATWOOT_PATH_TOKEN is required'),
  // Optional at boot so dev/Studio works without it. Validated at call-site
  // (src/lib/chatwoot.ts → requireChatwootToken) when an outbound API call
  // actually needs it (Day 3 handoff, Day 2 reply post).
  CHATWOOT_API_TOKEN: z.string().default(''),

  CALENDLY_LINK: z.string().default(''),

  // LibSQL URL for Mastra Memory storage. Default is a local file at the
  // project root for dev. In Docker we override to point inside a mounted
  // volume so memory survives container restarts.
  MASTRA_DB_URL: z.string().default('file:./mastra.db'),

  // Twenty CRM (v2). All optional at boot — when TWENTY_API_KEY is empty the
  // upsert tool short-circuits and logs a warning so dev/Studio works without
  // a CRM connection. Validated at call-site (src/lib/twenty.ts → requireTwentyConfig).
  // TWENTY_OWNER_USER_ID is the workspaceMember.id (not the User.id) — this
  // is what Twenty's accountOwnerId field expects on Company records.
  TWENTY_API_URL: z.string().default(''),
  TWENTY_API_KEY: z.string().default(''),
  TWENTY_OWNER_USER_ID: z.string().default(''),

  // Google Calendar (v2 Sprint 3). All optional at boot — when
  // GOOGLE_CALENDAR_CREDENTIALS_JSON is empty the agendador tool short-circuits
  // and falls through to chatwoot-handoff so dev/Studio works without GCP.
  // GOOGLE_CALENDAR_CREDENTIALS_JSON: full service-account JSON key as a
  //   single-line string. Generated in GCP Console → IAM → Service Accounts.
  // CALENDAR_IDS_TO_CHECK: comma-separated list of calendar emails whose busy
  //   times must be intersected (a slot is free only if free in ALL of them).
  // CALENDAR_PRIMARY: the calendar where new events are CREATED. Usually the
  //   first one in CALENDAR_IDS_TO_CHECK. Other calendars are read-only for
  //   busy-time checks and are added as `attendees` on the created event.
  GOOGLE_CALENDAR_CREDENTIALS_JSON: z.string().default(''),
  CALENDAR_IDS_TO_CHECK: z.string().default(''),
  CALENDAR_PRIMARY: z.string().default(''),

  // Langfuse observability (v4 Sprint 1). All optional at boot — when keys are
  // empty no Langfuse exporter is registered and traces only live in Mastra
  // Studio (DefaultExporter). When configured, every agent.generate() + tool
  // call + sub-agent delegation gets exported to Langfuse with conversationId
  // as sessionId.
  // LANGFUSE_BASE_URL: full URL of self-hosted Langfuse (e.g.
  //   'https://langfuse.fomologic.com'). Empty defaults to cloud.langfuse.com.
  // LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY: from Langfuse Settings → API Keys.
  LANGFUSE_BASE_URL: z.string().default(''),
  LANGFUSE_PUBLIC_KEY: z.string().default(''),
  LANGFUSE_SECRET_KEY: z.string().default(''),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  PORT: z.coerce.number().int().positive().default(4111),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
