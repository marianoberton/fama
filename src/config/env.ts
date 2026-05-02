import { z } from 'zod';

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),

  CHATWOOT_BASE_URL: z.string().url(),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
  CHATWOOT_INBOX_ID: z.coerce.number().int().positive(),
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
