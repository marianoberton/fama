import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_ID = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '1';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
  process.env.CHATWOOT_API_TOKEN = 'test-cw-token';
  process.env.TWENTY_API_URL = 'https://crm.test.local/rest';
  process.env.TWENTY_API_KEY = 'test-twenty-key';
  process.env.TWENTY_OWNER_USER_ID = 'owner-uuid';
});

vi.mock('../../../src/lib/google-calendar.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/lib/google-calendar.js')>();
  return {
    ...actual,
    isGoogleCalendarConfigured: vi.fn().mockReturnValue(true),
    requireGoogleCalendarConfig: vi.fn(),
    fetchBusyIntervals: vi.fn(),
    createCalendarEvent: vi.fn(),
  };
});

vi.mock('../../../src/lib/twenty.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/lib/twenty.js')>();
  return {
    ...actual,
    isTwentyConfigured: vi.fn().mockReturnValue(true),
    findOrCreatePersonByPhone: vi.fn(),
    findOpportunityByPersonId: vi.fn(),
    createOpportunity: vi.fn(),
    updateOpportunity: vi.fn(),
    createNote: vi.fn(),
    attachNoteToPerson: vi.fn(),
  };
});

vi.mock('../../../src/lib/chatwoot.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/lib/chatwoot.js')>();
  return {
    ...actual,
    sendChatwootMessage: vi.fn(),
    addChatwootLabels: vi.fn(),
  };
});

const { runBookCalendarEvent } = await import(
  '../../../src/mastra/tools/book-calendar-event.js'
);
const gcal = await import('../../../src/lib/google-calendar.js');
const twenty = await import('../../../src/lib/twenty.js');
const chatwoot = await import('../../../src/lib/chatwoot.js');

const mIsGcalConfigured = vi.mocked(gcal.isGoogleCalendarConfigured);
const mRequireConfig = vi.mocked(gcal.requireGoogleCalendarConfig);
const mFetchBusy = vi.mocked(gcal.fetchBusyIntervals);
const mCreateEvent = vi.mocked(gcal.createCalendarEvent);
const mFindOrCreatePerson = vi.mocked(twenty.findOrCreatePersonByPhone);
const mFindOpp = vi.mocked(twenty.findOpportunityByPersonId);
const mCreateOpp = vi.mocked(twenty.createOpportunity);
const mUpdateOpp = vi.mocked(twenty.updateOpportunity);
const mCreateNote = vi.mocked(twenty.createNote);
const mAttachNote = vi.mocked(twenty.attachNoteToPerson);
const mIsTwentyConfigured = vi.mocked(twenty.isTwentyConfigured);
const mSendChatwoot = vi.mocked(chatwoot.sendChatwootMessage);
const mAddLabels = vi.mocked(chatwoot.addChatwootLabels);

const ctx = {
  phone: '+5491132766709',
  conversationId: 4248,
  contactName: 'Mariano',
};

const FUTURE_SLOT = Date.UTC(2030, 0, 1, 12, 0); // arbitrary future epoch

const baseInput = {
  slotStartMs: FUTURE_SLOT,
  customerName: 'Juan Pérez',
  customerEmail: 'juan@acme.com',
  category: 'venta-agentes' as const,
  summary: 'FOMO – Demo con Acme (agentes IA)',
  contextNote: 'Categoría: venta-agentes\nMotivo: cliente quiere automatizar atención al cliente',
};

beforeEach(() => {
  vi.clearAllMocks();
  mIsGcalConfigured.mockReturnValue(true);
  mIsTwentyConfigured.mockReturnValue(true);
  mRequireConfig.mockReturnValue({
    credentials: { client_email: 'sa@test.iam', private_key: 'key' },
    calendarIds: ['mariano@fomo.com.ar', 'guille@fomo.com.ar'],
    primaryCalendarId: 'mariano@fomo.com.ar',
  });
});

describe('book-calendar-event — pre-flight checks', () => {
  it('returns reason=calendar_not_configured when env is missing', async () => {
    mIsGcalConfigured.mockReturnValue(false);
    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(false);
    expect(out.reason).toBe('calendar_not_configured');
    expect(mFetchBusy).not.toHaveBeenCalled();
    expect(mCreateEvent).not.toHaveBeenCalled();
  });

  it('returns reason=slot_taken when freebusy shows the slot is now busy', async () => {
    mFetchBusy.mockResolvedValue([
      { startMs: FUTURE_SLOT - 5 * 60 * 1000, endMs: FUTURE_SLOT + 35 * 60 * 1000 },
    ]);
    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(false);
    expect(out.reason).toBe('slot_taken');
    expect(mCreateEvent).not.toHaveBeenCalled();
  });

  it('returns reason=calendar_api_error when freebusy throws', async () => {
    mFetchBusy.mockRejectedValue(new Error('boom'));
    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(false);
    expect(out.reason).toBe('calendar_api_error');
  });
});

describe('book-calendar-event — happy path', () => {
  beforeEach(() => {
    mFetchBusy.mockResolvedValue([]);
    mCreateEvent.mockResolvedValue({
      eventId: 'evt-1',
      htmlLink: 'https://calendar.google.com/event?eid=...',
      meetLink: 'https://meet.google.com/abc-defg-hij',
      startIso: '2030-01-01T12:00:00.000Z',
      endIso: '2030-01-01T12:30:00.000Z',
    });
    mFindOrCreatePerson.mockResolvedValue({
      person: { id: 'person-1' },
      created: false,
    });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'opp-1', stage: 'MEETING' });
    mCreateNote.mockResolvedValue({ id: 'note-1' });
    mAttachNote.mockResolvedValue();
    mSendChatwoot.mockResolvedValue();
    mAddLabels.mockResolvedValue();
  });

  it('creates Calendar event + Twenty Opportunity + Note + Chatwoot note + label', async () => {
    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(true);
    expect(out.eventId).toBe('evt-1');
    expect(out.meetLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(out.scheduledFor).toMatch(/\d/);

    // Calendar event creation
    expect(mCreateEvent).toHaveBeenCalledOnce();
    const evCall = mCreateEvent.mock.calls[0]![0];
    expect(evCall.startMs).toBe(FUTURE_SLOT);
    expect(evCall.summary).toBe(baseInput.summary);
    // Internal attendees (guille) + customer
    expect(evCall.attendeeEmails).toContain('guille@fomo.com.ar');
    expect(evCall.attendeeEmails).toContain('juan@acme.com');
    // Primary calendar (mariano) is NOT in attendees — he's the organizer
    expect(evCall.attendeeEmails).not.toContain('mariano@fomo.com.ar');

    // Twenty: new Opportunity created with stage=MEETING + arquetipo=CALIENTE
    expect(mCreateOpp).toHaveBeenCalledOnce();
    expect(mCreateOpp.mock.calls[0]![0]).toMatchObject({
      pointOfContactId: 'person-1',
      stage: 'MEETING',
      arquetipo: 'CALIENTE',
    });
    expect(mUpdateOpp).not.toHaveBeenCalled();

    // Note created + attached
    expect(mCreateNote).toHaveBeenCalledOnce();
    expect(mAttachNote).toHaveBeenCalledWith({ noteId: 'note-1', personId: 'person-1' });

    // Chatwoot: private note + label
    expect(mSendChatwoot).toHaveBeenCalledOnce();
    expect(mSendChatwoot.mock.calls[0]![0].private).toBe(true);
    expect(mAddLabels).toHaveBeenCalledOnce();
    expect(mAddLabels.mock.calls[0]![0].labels).toEqual(['venta-agentes']);
  });

  it('updates existing Opportunity instead of creating a duplicate', async () => {
    mFindOpp.mockResolvedValue({ id: 'opp-existing', stage: 'CONTACTED' });
    mUpdateOpp.mockResolvedValue({ id: 'opp-existing', stage: 'MEETING' });

    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(true);
    expect(mCreateOpp).not.toHaveBeenCalled();
    expect(mUpdateOpp).toHaveBeenCalledOnce();
    expect(mUpdateOpp.mock.calls[0]![1]).toMatchObject({
      stage: 'MEETING',
      arquetipo: 'CALIENTE',
    });
  });

  it('does NOT downgrade stage when the existing one is already PROPOSAL', async () => {
    mFindOpp.mockResolvedValue({ id: 'opp-existing', stage: 'PROPOSAL' });

    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(true);
    // stage MEETING < PROPOSAL → canAdvanceStage returns false → no update
    expect(mUpdateOpp).not.toHaveBeenCalled();
  });
});

describe('book-calendar-event — failure isolation (best-effort sync)', () => {
  beforeEach(() => {
    mFetchBusy.mockResolvedValue([]);
    mCreateEvent.mockResolvedValue({
      eventId: 'evt-1',
      htmlLink: 'https://calendar.google.com/...',
      meetLink: 'https://meet.google.com/xxx',
      startIso: '2030-01-01T12:00:00.000Z',
      endIso: '2030-01-01T12:30:00.000Z',
    });
  });

  it('returns success=true even when Twenty sync throws (event already in Calendar)', async () => {
    mFindOrCreatePerson.mockRejectedValue(new Error('twenty 500'));
    mSendChatwoot.mockResolvedValue();
    mAddLabels.mockResolvedValue();

    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(true);
    expect(out.eventId).toBe('evt-1');
    // Chatwoot still ran since it's independent of Twenty
    expect(mSendChatwoot).toHaveBeenCalled();
  });

  it('returns success=true even when Chatwoot sync throws', async () => {
    mFindOrCreatePerson.mockResolvedValue({ person: { id: 'p1' }, created: false });
    mFindOpp.mockResolvedValue(null);
    mCreateOpp.mockResolvedValue({ id: 'opp1', stage: 'MEETING' });
    mCreateNote.mockResolvedValue({ id: 'note1' });
    mAttachNote.mockResolvedValue();
    mSendChatwoot.mockRejectedValue(new Error('chatwoot 500'));
    mAddLabels.mockResolvedValue();

    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(true);
    expect(out.eventId).toBe('evt-1');
  });

  it('returns success=false when Calendar createEvent itself fails', async () => {
    mCreateEvent.mockRejectedValue(new Error('quota exceeded'));

    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(false);
    expect(out.reason).toBe('calendar_api_error');
    // Downstream syncs should NOT run if the event itself didn't get created
    expect(mFindOrCreatePerson).not.toHaveBeenCalled();
    expect(mSendChatwoot).not.toHaveBeenCalled();
  });
});

describe('book-calendar-event — Twenty/Chatwoot skip when not configured', () => {
  it('skips Twenty sync silently when TWENTY_API_KEY is empty', async () => {
    mFetchBusy.mockResolvedValue([]);
    mCreateEvent.mockResolvedValue({
      eventId: 'evt-1',
      htmlLink: 'https://calendar.google.com/...',
      meetLink: 'https://meet.google.com/xxx',
      startIso: '2030-01-01T12:00:00.000Z',
      endIso: '2030-01-01T12:30:00.000Z',
    });
    mIsTwentyConfigured.mockReturnValue(false);
    mSendChatwoot.mockResolvedValue();
    mAddLabels.mockResolvedValue();

    const out = await runBookCalendarEvent(baseInput, ctx);
    expect(out.success).toBe(true);
    expect(mFindOrCreatePerson).not.toHaveBeenCalled();
    // Chatwoot still runs (independent gate)
    expect(mSendChatwoot).toHaveBeenCalled();
  });
});
