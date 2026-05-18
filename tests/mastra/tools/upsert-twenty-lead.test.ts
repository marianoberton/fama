import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_IDS = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '1';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
  // Default for these tests: Twenty IS configured. Individual tests can stub
  // isTwentyConfigured to flip behavior.
  process.env.TWENTY_API_URL = 'https://crm.test.local/rest';
  process.env.TWENTY_API_KEY = 'test-key';
  process.env.TWENTY_OWNER_USER_ID = 'owner-uuid';
});

vi.mock('../../../src/lib/twenty.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/lib/twenty.js')>();
  return {
    ...actual,
    isTwentyConfigured: vi.fn().mockReturnValue(true),
    findPersonByPhone: vi.fn(),
    createPerson: vi.fn(),
    updatePerson: vi.fn(),
    findCompanyByName: vi.fn(),
    createCompany: vi.fn(),
    findOpportunityByPersonId: vi.fn(),
    createOpportunity: vi.fn(),
    updateOpportunity: vi.fn(),
    createNote: vi.fn(),
    attachNoteToPerson: vi.fn(),
  };
});

const {
  upsertTwentyLeadInput,
  upsertTwentyLeadOutput,
  runUpsertTwentyLead,
  TWENTY_LEAD_STAGES,
  TWENTY_LEAD_SOURCES,
} = await import('../../../src/mastra/tools/upsert-twenty-lead.js');
const twenty = await import('../../../src/lib/twenty.js');

const mFindPerson = vi.mocked(twenty.findPersonByPhone);
const mCreatePerson = vi.mocked(twenty.createPerson);
const mUpdatePerson = vi.mocked(twenty.updatePerson);
const mFindCompany = vi.mocked(twenty.findCompanyByName);
const mCreateCompany = vi.mocked(twenty.createCompany);
const mFindOpp = vi.mocked(twenty.findOpportunityByPersonId);
const mCreateOpp = vi.mocked(twenty.createOpportunity);
const mUpdateOpp = vi.mocked(twenty.updateOpportunity);
const mCreateNote = vi.mocked(twenty.createNote);
const mAttachNote = vi.mocked(twenty.attachNoteToPerson);
const mIsConfigured = vi.mocked(twenty.isTwentyConfigured);

beforeEach(() => {
  vi.clearAllMocks();
  mIsConfigured.mockReturnValue(true);
});

const ctx = { phone: '+5491132766709', conversationId: 4248 };

describe('upsert-twenty-lead schema', () => {
  it('does NOT accept phone as a field (it comes from RequestContext now)', () => {
    const parsed = upsertTwentyLeadInput.parse({ stage: 'NEW' });
    expect(parsed).not.toHaveProperty('phone');
    expect(parsed.source).toBe('whatsapp'); // default
  });

  it('accepts all 6 valid stages', () => {
    for (const stage of TWENTY_LEAD_STAGES) {
      expect(upsertTwentyLeadInput.parse({ stage }).stage).toBe(stage);
    }
  });

  it('rejects an invalid stage value', () => {
    expect(upsertTwentyLeadInput.safeParse({ stage: 'QUALIFIED' }).success).toBe(false);
  });

  it('rejects when stage is missing', () => {
    expect(upsertTwentyLeadInput.safeParse({}).success).toBe(false);
  });

  it('accepts all 4 valid sources', () => {
    for (const source of TWENTY_LEAD_SOURCES) {
      expect(upsertTwentyLeadInput.parse({ stage: 'CONTACTED', source }).source).toBe(source);
    }
  });

  it('accepts all 4 arquetipo values', () => {
    for (const arquetipo of ['caliente', 'a-explorar', 'sin-claridad', 'no-lead'] as const) {
      expect(
        upsertTwentyLeadInput.parse({ stage: 'NEW', arquetipo }).arquetipo,
      ).toBe(arquetipo);
    }
  });

  it('accepts all 5 exception values', () => {
    for (const exception of [
      'pedido-humano',
      'consultoria',
      'urgencia',
      'reclamo',
      'demo',
    ] as const) {
      expect(
        upsertTwentyLeadInput.parse({ stage: 'MEETING', exception }).exception,
      ).toBe(exception);
    }
  });

  it('rejects an invalid email', () => {
    expect(
      upsertTwentyLeadInput.safeParse({ stage: 'NEW', email: 'not-an-email' }).success,
    ).toBe(false);
  });
});

describe('runUpsertTwentyLead — Person create flow (new lead)', () => {
  it('creates Person + Opportunity when no existing Person and no company', async () => {
    mFindPerson.mockResolvedValue(null);
    mCreatePerson.mockResolvedValue({ id: 'p1', name: { firstName: 'Mariano' } });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });

    const out = await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'NEW', name: 'Mariano' }),
      ctx,
    );

    expect(out.success).toBe(true);
    expect(out.personId).toBe('p1');
    expect(out.opportunityId).toBe('o1');
    expect(out.leadId).toBe('o1');
    expect(mCreatePerson).toHaveBeenCalledOnce();
    expect(mCreatePerson.mock.calls[0]![0]).toMatchObject({
      firstName: 'Mariano',
      phone: '+5491132766709',
      messageCount: 1,
    });
    expect(mFindCompany).not.toHaveBeenCalled();
    expect(mCreateCompany).not.toHaveBeenCalled();
    expect(mCreateOpp).toHaveBeenCalledOnce();
    expect(mCreateOpp.mock.calls[0]![0]).toMatchObject({
      pointOfContactId: 'p1',
      stage: 'NEW',
      sourceChannel: 'WHATSAPP',
    });
  });

  it('uses "Anónimo" when no name was given', async () => {
    mFindPerson.mockResolvedValue(null);
    mCreatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });

    await runUpsertTwentyLead(upsertTwentyLeadInput.parse({ stage: 'NEW' }), ctx);

    expect(mCreatePerson.mock.calls[0]![0]).toMatchObject({
      firstName: 'Anónimo',
      lastName: '',
    });
  });

  it('creates a Company when one is mentioned and not already in Twenty', async () => {
    mFindPerson.mockResolvedValue(null);
    mFindCompany.mockResolvedValue(null);
    mCreateCompany.mockResolvedValue({ id: 'c1', name: 'Acme' });
    mCreatePerson.mockResolvedValue({ id: 'p1', companyId: 'c1' });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'o1', stage: 'CONTACTED', companyId: 'c1' });

    await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'CONTACTED', company: 'Acme', name: 'Juan' }),
      ctx,
    );

    expect(mFindCompany).toHaveBeenCalledWith('Acme');
    expect(mCreateCompany).toHaveBeenCalledWith({
      name: 'Acme',
      accountOwnerId: 'owner-uuid',
    });
    expect(mCreatePerson.mock.calls[0]![0].companyId).toBe('c1');
    expect(mCreateOpp.mock.calls[0]![0].companyId).toBe('c1');
  });

  it('reuses existing Company instead of creating a duplicate', async () => {
    mFindPerson.mockResolvedValue(null);
    mFindCompany.mockResolvedValue({ id: 'c-existing', name: 'Acme' });
    mCreatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });

    await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'NEW', company: 'Acme' }),
      ctx,
    );

    expect(mCreateCompany).not.toHaveBeenCalled();
    expect(mCreatePerson.mock.calls[0]![0].companyId).toBe('c-existing');
  });

  it('passes arquetipo + exception to createOpportunity (mapped to UPPERCASE)', async () => {
    mFindPerson.mockResolvedValue(null);
    mCreatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'o1', stage: 'MEETING' });

    await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({
        stage: 'MEETING',
        arquetipo: 'caliente',
        exception: 'pedido-humano',
      }),
      ctx,
    );

    expect(mCreateOpp.mock.calls[0]![0]).toMatchObject({
      arquetipo: 'CALIENTE',
      exception: 'PEDIDO_HUMANO',
    });
  });
});

describe('runUpsertTwentyLead — Person update flow (returning lead)', () => {
  it('updates Person fields that are empty in Twenty (merge intelligently)', async () => {
    mFindPerson.mockResolvedValue({
      id: 'p1',
      name: { firstName: 'Mariano', lastName: '' },
      emails: { primaryEmail: null }, // empty → can be filled
      phones: { primaryPhoneNumber: '91132766709' },
      companyId: null,
      messageCount: 3,
    });
    mUpdatePerson.mockResolvedValue({
      id: 'p1',
      name: { firstName: 'Mariano' },
      emails: { primaryEmail: 'mariano@acme.com' },
    });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });

    await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({
        stage: 'NEW',
        email: 'mariano@acme.com',
      }),
      ctx,
    );

    expect(mCreatePerson).not.toHaveBeenCalled();
    expect(mUpdatePerson).toHaveBeenCalledOnce();
    const patch = mUpdatePerson.mock.calls[0]![1];
    expect(patch.email).toBe('mariano@acme.com');
    expect(patch.lastContactAt).toBeDefined(); // always-update
    expect(patch.messageCount).toBe(4); // 3 + 1
    // name should NOT be overwritten — Mariano already has firstName.
    expect(patch.firstName).toBeUndefined();
  });

  it('does NOT overwrite a name that is already set', async () => {
    mFindPerson.mockResolvedValue({
      id: 'p1',
      name: { firstName: 'Mariano', lastName: 'Berton' },
    });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });

    await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'NEW', name: 'Carlos González' }),
      ctx,
    );

    const patch = mUpdatePerson.mock.calls[0]![1];
    expect(patch.firstName).toBeUndefined();
    expect(patch.lastName).toBeUndefined();
  });

  it('always updates lastContactAt + messageCount even with no other patch', async () => {
    mFindPerson.mockResolvedValue({
      id: 'p1',
      name: { firstName: 'X', lastName: '' },
      messageCount: 0,
    });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'CONTACTED' });

    await runUpsertTwentyLead(upsertTwentyLeadInput.parse({ stage: 'CONTACTED' }), ctx);

    const patch = mUpdatePerson.mock.calls[0]![1];
    expect(patch.lastContactAt).toBeDefined();
    expect(patch.messageCount).toBe(1);
  });
});

describe('runUpsertTwentyLead — Opportunity stage progression', () => {
  it('advances stage when new stage is forward', async () => {
    mFindPerson.mockResolvedValue({ id: 'p1' });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'CONTACTED' });
    mUpdateOpp.mockResolvedValue({ id: 'o1', stage: 'MEETING' });

    await runUpsertTwentyLead(upsertTwentyLeadInput.parse({ stage: 'MEETING' }), ctx);

    expect(mUpdateOpp).toHaveBeenCalledOnce();
    expect(mUpdateOpp.mock.calls[0]![1].stage).toBe('MEETING');
  });

  it('does NOT advance stage backwards (e.g. MEETING → NEW)', async () => {
    mFindPerson.mockResolvedValue({ id: 'p1' });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'MEETING' });
    // Even though we omit stage from the patch, if no other field changes the
    // tool should NOT call updateOpportunity at all.

    await runUpsertTwentyLead(upsertTwentyLeadInput.parse({ stage: 'NEW' }), ctx);

    expect(mUpdateOpp).not.toHaveBeenCalled();
  });

  it('always allows LOST regardless of current stage', async () => {
    mFindPerson.mockResolvedValue({ id: 'p1' });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });
    mUpdateOpp.mockResolvedValue({ id: 'o1', stage: 'LOST' });

    await runUpsertTwentyLead(upsertTwentyLeadInput.parse({ stage: 'LOST' }), ctx);

    expect(mUpdateOpp.mock.calls[0]![1].stage).toBe('LOST');
  });

  it('treats SCREENING as CONTACTED (legacy alias) — does not retreat to NEW', async () => {
    mFindPerson.mockResolvedValue({ id: 'p1' });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'SCREENING' });

    await runUpsertTwentyLead(upsertTwentyLeadInput.parse({ stage: 'NEW' }), ctx);

    expect(mUpdateOpp).not.toHaveBeenCalled();
  });
});

describe('runUpsertTwentyLead — Notes', () => {
  it('creates a Note when notes is non-empty and attaches it to the Person', async () => {
    mFindPerson.mockResolvedValue({ id: 'p1' });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'CONTACTED' });
    mCreateNote.mockResolvedValue({ id: 'n1' });
    mAttachNote.mockResolvedValue();

    const out = await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({
        stage: 'CONTACTED',
        notes: 'Categoría: venta-agentes\nMotivo: pidió demo',
      }),
      ctx,
    );

    expect(mCreateNote).toHaveBeenCalledOnce();
    expect(mAttachNote).toHaveBeenCalledWith({ noteId: 'n1', personId: 'p1' });
    expect(out.noteId).toBe('n1');
  });

  it('does NOT create a Note when notes is empty / whitespace', async () => {
    mFindPerson.mockResolvedValue({ id: 'p1' });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });

    await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'NEW', notes: '   ' }),
      ctx,
    );

    expect(mCreateNote).not.toHaveBeenCalled();
  });

  it('still reports success when Note creation fails (lead is recorded)', async () => {
    mFindPerson.mockResolvedValue({ id: 'p1' });
    mUpdatePerson.mockResolvedValue({ id: 'p1' });
    mFindOpp.mockResolvedValue({ id: 'o1', stage: 'NEW' });
    mCreateNote.mockRejectedValue(new Error('twenty 500'));

    const out = await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'NEW', notes: 'something' }),
      ctx,
    );

    expect(out.success).toBe(true);
    expect(out.noteId).toBeUndefined();
  });
});

describe('runUpsertTwentyLead — failure modes', () => {
  it('returns success=true skipped=true when Twenty is not configured', async () => {
    mIsConfigured.mockReturnValue(false);

    const out = await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'NEW' }),
      ctx,
    );

    const validated = upsertTwentyLeadOutput.parse(out);
    expect(validated.success).toBe(true);
    expect(validated.skipped).toBe(true);
    expect(mFindPerson).not.toHaveBeenCalled();
  });

  it('returns success=false with error when an underlying call throws', async () => {
    mFindPerson.mockRejectedValue(new Error('network down'));

    const out = await runUpsertTwentyLead(
      upsertTwentyLeadInput.parse({ stage: 'NEW' }),
      ctx,
    );

    expect(out.success).toBe(false);
    expect(out.error).toContain('network down');
  });
});
