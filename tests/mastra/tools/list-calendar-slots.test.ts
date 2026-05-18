import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_IDS = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '1';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
});

vi.mock('../../../src/lib/google-calendar.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/lib/google-calendar.js')>();
  return {
    ...actual,
    isGoogleCalendarConfigured: vi.fn().mockReturnValue(true),
    fetchBusyIntervals: vi.fn(),
  };
});

const { listCalendarSlots } = await import('../../../src/mastra/tools/list-calendar-slots.js');
const gcal = await import('../../../src/lib/google-calendar.js');
const mIsConfigured = vi.mocked(gcal.isGoogleCalendarConfigured);
const mFetchBusy = vi.mocked(gcal.fetchBusyIntervals);

beforeEach(() => {
  vi.clearAllMocks();
  mIsConfigured.mockReturnValue(true);
});

const execute = listCalendarSlots.execute as (input: unknown) => Promise<unknown>;

describe('list-calendar-slots', () => {
  it('returns empty slots with reason=calendar_not_configured when env is missing', async () => {
    mIsConfigured.mockReturnValue(false);
    const out = (await execute({ count: 2 })) as { slots: unknown[]; reason: string };
    expect(out.slots).toEqual([]);
    expect(out.reason).toBe('calendar_not_configured');
    expect(mFetchBusy).not.toHaveBeenCalled();
  });

  it('returns 2 slots when no busy intervals (full availability)', async () => {
    mFetchBusy.mockResolvedValue([]);
    const out = (await execute({ count: 2 })) as {
      slots: Array<{ slotStartMs: number; humanLabel: string; startIso: string; endIso: string }>;
      reason: string | null;
    };
    expect(out.reason).toBeNull();
    expect(out.slots).toHaveLength(2);
    expect(out.slots[0]?.humanLabel).toMatch(/UTC-3/);
    expect(typeof out.slots[0]?.slotStartMs).toBe('number');
    // Two consecutive 30-min slots
    expect(out.slots[1]?.slotStartMs).toBe(out.slots[0]!.slotStartMs + 30 * 60 * 1000);
  });

  it('returns count=3 when caller asks for 3', async () => {
    mFetchBusy.mockResolvedValue([]);
    const out = (await execute({ count: 3 })) as { slots: unknown[]; reason: string | null };
    expect(out.slots).toHaveLength(3);
    expect(out.reason).toBeNull();
  });

  it('returns reason=calendar_api_error when freebusy throws GoogleCalendarApiError', async () => {
    mFetchBusy.mockRejectedValue(new gcal.GoogleCalendarApiError(new Error('boom'), 'boom'));
    const out = (await execute({ count: 2 })) as { slots: unknown[]; reason: string };
    expect(out.slots).toEqual([]);
    expect(out.reason).toBe('calendar_api_error');
  });

  it('returns reason=unknown_error on a generic throw', async () => {
    mFetchBusy.mockRejectedValue(new Error('network down'));
    const out = (await execute({ count: 2 })) as { slots: unknown[]; reason: string };
    expect(out.slots).toEqual([]);
    expect(out.reason).toBe('unknown_error');
  });

  it('returns no_free_slots when every candidate is busy', async () => {
    // Block the entire 7-day search window with a single huge interval.
    const start = Date.now() - 1000;
    const end = start + 30 * 24 * 60 * 60 * 1000; // 30 days
    mFetchBusy.mockResolvedValue([{ startMs: start, endMs: end }]);
    const out = (await execute({ count: 2 })) as { slots: unknown[]; reason: string };
    expect(out.slots).toEqual([]);
    expect(out.reason).toBe('no_free_slots');
  });
});
