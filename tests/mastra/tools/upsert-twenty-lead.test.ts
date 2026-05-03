import { describe, it, expect, beforeAll, vi } from 'vitest';

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
  upsertTwentyLeadInput,
  upsertTwentyLeadOutput,
  upsertTwentyLead,
  TWENTY_LEAD_STAGES,
  TWENTY_LEAD_SOURCES,
} = await import('../../../src/mastra/tools/upsert-twenty-lead.js');

describe('upsert-twenty-lead schema', () => {
  it('accepts the minimum required fields (phone + stage), defaults source to whatsapp', () => {
    const parsed = upsertTwentyLeadInput.parse({
      phone: '+5491122334455',
      stage: 'NEW',
    });
    expect(parsed.source).toBe('whatsapp');
    expect(parsed.phone).toBe('+5491122334455');
  });

  it('accepts all 6 valid stages', () => {
    for (const stage of TWENTY_LEAD_STAGES) {
      const parsed = upsertTwentyLeadInput.parse({ phone: '+5491122334455', stage });
      expect(parsed.stage).toBe(stage);
    }
  });

  it('rejects an invalid stage value', () => {
    const result = upsertTwentyLeadInput.safeParse({
      phone: '+5491122334455',
      stage: 'QUALIFIED', // legacy / not in our enum
    });
    expect(result.success).toBe(false);
  });

  it('rejects when phone is missing', () => {
    const result = upsertTwentyLeadInput.safeParse({ stage: 'NEW' });
    expect(result.success).toBe(false);
  });

  it('rejects when stage is missing', () => {
    const result = upsertTwentyLeadInput.safeParse({ phone: '+5491122334455' });
    expect(result.success).toBe(false);
  });

  it('accepts all 4 valid sources', () => {
    for (const source of TWENTY_LEAD_SOURCES) {
      const parsed = upsertTwentyLeadInput.parse({
        phone: '+5491122334455',
        stage: 'CONTACTED',
        source,
      });
      expect(parsed.source).toBe(source);
    }
  });

  it('rejects an invalid email', () => {
    const result = upsertTwentyLeadInput.safeParse({
      phone: '+5491122334455',
      stage: 'NEW',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });
});

describe('upsert-twenty-lead execute (mock v1)', () => {
  it('returns success + leadId without throwing', async () => {
    const input = upsertTwentyLeadInput.parse({
      name: 'María González',
      phone: '+5491122334455',
      email: 'maria@acme.com',
      company: 'Acme S.A.',
      stage: 'MEETING',
      source: 'whatsapp',
      notes: 'Lead caliente, pidió demo para 3 agentes.',
    });
    const execute = upsertTwentyLead.execute as (i: unknown) => Promise<unknown>;
    const result = await execute(input);
    const out = upsertTwentyLeadOutput.parse(result);
    expect(out.success).toBe(true);
    expect(out.leadId).toMatch(/^mock-/);
  });

  it('logs with the // MOCK: prefix so it is greppable in prod', async () => {
    const { logger } = await import('../../../src/lib/logger.js');
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      const input = upsertTwentyLeadInput.parse({
        phone: '+5491122334455',
        stage: 'NEW',
      });
      const execute = upsertTwentyLead.execute as (i: unknown) => Promise<unknown>;
      await execute(input);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ mockTool: 'upsert-twenty-lead' }),
        expect.stringContaining('// MOCK:'),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
