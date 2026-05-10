import { describe, it, expect } from 'vitest';
import {
  startOfNextBusinessDay,
  generateCandidateSlots,
  isSlotFree,
  isSlotOnCandidateGrid,
  findAvailableSlots,
  formatSlotForHumans,
  AR_OFFSET_HOURS,
  SLOT_DURATION_MIN,
  BUFFER_MIN,
} from '../../src/lib/availability.js';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const AR_OFFSET = AR_OFFSET_HOURS * HOUR;

/** Builds an epoch ms for "AR clock" components. AR is UTC-3 fixed. */
function arEpoch(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m, d, h, min) + AR_OFFSET;
}

describe('startOfNextBusinessDay', () => {
  it('weekday → next weekday at 9am AR', () => {
    // Tuesday May 5, 2026 14:00 AR
    const now = arEpoch(2026, 4, 5, 14, 0);
    const expected = arEpoch(2026, 4, 6, 9, 0); // Wed 9am AR
    expect(startOfNextBusinessDay(now)).toBe(expected);
  });

  it('Friday → Monday', () => {
    const friday = arEpoch(2026, 4, 1, 18, 0); // Fri May 1, 2026 18:00 AR
    const monday = arEpoch(2026, 4, 4, 9, 0); // Mon May 4, 2026 9am AR
    expect(startOfNextBusinessDay(friday)).toBe(monday);
  });

  it('Saturday → Monday', () => {
    const saturday = arEpoch(2026, 4, 2, 12, 0);
    const monday = arEpoch(2026, 4, 4, 9, 0);
    expect(startOfNextBusinessDay(saturday)).toBe(monday);
  });

  it('Sunday → Monday', () => {
    const sunday = arEpoch(2026, 4, 3, 23, 30);
    const monday = arEpoch(2026, 4, 4, 9, 0);
    expect(startOfNextBusinessDay(sunday)).toBe(monday);
  });

  it('never returns same-day slots — even at 1am, the next slot is tomorrow 9am', () => {
    const earlyMonday = arEpoch(2026, 4, 4, 1, 0);
    const tuesday = arEpoch(2026, 4, 5, 9, 0);
    expect(startOfNextBusinessDay(earlyMonday)).toBe(tuesday);
  });
});

describe('generateCandidateSlots', () => {
  it('produces 30-min slots from 9am to 19hs (last starts 18:30) over 7 days, skipping weekends', () => {
    const monday = arEpoch(2026, 4, 4, 10, 0);
    const slots = generateCandidateSlots({ nowMs: monday, windowDays: 7 });
    // Search starts from "next business day" = Tuesday May 5. windowDays=7
    // covers calendar days Tue (5), Wed (6), Thu (7), Fri (8), Sat (9), Sun (10), Mon (11).
    // Sat + Sun skipped → 5 weekdays. 9 to 18:30 stepping 30 min = 20 slots/day.
    // 5 days × 20 = 100 slots.
    expect(slots).toHaveLength(100);
    // First slot is Tue May 5 at 9am AR.
    expect(slots[0]?.startMs).toBe(arEpoch(2026, 4, 5, 9, 0));
    expect(slots[0]?.endMs).toBe(arEpoch(2026, 4, 5, 9, 30));
    // Last slot of day 1 is Tue May 5 at 18:30 AR.
    const day1Slots = slots.filter(
      (s) => s.startMs >= arEpoch(2026, 4, 5, 0, 0) && s.startMs < arEpoch(2026, 4, 6, 0, 0),
    );
    expect(day1Slots[day1Slots.length - 1]?.startMs).toBe(arEpoch(2026, 4, 5, 18, 30));
  });

  it('every slot is exactly SLOT_DURATION_MIN long', () => {
    const slots = generateCandidateSlots({ nowMs: arEpoch(2026, 4, 4, 10, 0), windowDays: 1 });
    for (const s of slots) {
      expect(s.endMs - s.startMs).toBe(SLOT_DURATION_MIN * MIN);
    }
  });

  it('windowDays=1 yields slots only for one weekday', () => {
    const monday = arEpoch(2026, 4, 4, 10, 0); // tomorrow = Tue May 5
    const slots = generateCandidateSlots({ nowMs: monday, windowDays: 1 });
    expect(slots).toHaveLength(20);
    expect(slots.every((s) => s.startMs >= arEpoch(2026, 4, 5, 9, 0))).toBe(true);
    expect(slots.every((s) => s.startMs < arEpoch(2026, 4, 6, 0, 0))).toBe(true);
  });
});

describe('isSlotFree', () => {
  const slot = { startMs: arEpoch(2026, 4, 5, 11, 0), endMs: arEpoch(2026, 4, 5, 11, 30) };
  const buffer = BUFFER_MIN * MIN;

  it('returns true when busy is empty', () => {
    expect(isSlotFree({ slot, busy: [], bufferMs: buffer })).toBe(true);
  });

  it('returns false when a busy interval directly overlaps', () => {
    const busy = [{ startMs: arEpoch(2026, 4, 5, 11, 15), endMs: arEpoch(2026, 4, 5, 11, 45) }];
    expect(isSlotFree({ slot, busy, bufferMs: buffer })).toBe(false);
  });

  it('returns false when busy interval falls in the buffer zone (before)', () => {
    // Busy ends at 10:55, slot starts at 11:00 with 15min buffer = 10:45.
    // 10:55 > 10:45 → overlaps.
    const busy = [{ startMs: arEpoch(2026, 4, 5, 10, 0), endMs: arEpoch(2026, 4, 5, 10, 55) }];
    expect(isSlotFree({ slot, busy, bufferMs: buffer })).toBe(false);
  });

  it('returns false when busy interval falls in the buffer zone (after)', () => {
    // Slot ends 11:30, slot+buffer ends 11:45. Busy starts 11:35 → overlaps.
    const busy = [{ startMs: arEpoch(2026, 4, 5, 11, 35), endMs: arEpoch(2026, 4, 5, 12, 0) }];
    expect(isSlotFree({ slot, busy, bufferMs: buffer })).toBe(false);
  });

  it('returns true when busy is far enough before the buffer', () => {
    // Busy ends 10:30, slot+buffer starts 10:45. Free.
    const busy = [{ startMs: arEpoch(2026, 4, 5, 10, 0), endMs: arEpoch(2026, 4, 5, 10, 30) }];
    expect(isSlotFree({ slot, busy, bufferMs: buffer })).toBe(true);
  });

  it('returns true when busy is far enough after the buffer', () => {
    // Slot+buffer ends 11:45. Busy starts 12:00. Free.
    const busy = [{ startMs: arEpoch(2026, 4, 5, 12, 0), endMs: arEpoch(2026, 4, 5, 13, 0) }];
    expect(isSlotFree({ slot, busy, bufferMs: buffer })).toBe(true);
  });

  it('multi-interval: false if ANY interval intersects', () => {
    const busy = [
      { startMs: arEpoch(2026, 4, 5, 8, 0), endMs: arEpoch(2026, 4, 5, 9, 0) }, // far before
      { startMs: arEpoch(2026, 4, 5, 11, 20), endMs: arEpoch(2026, 4, 5, 11, 25) }, // overlaps
    ];
    expect(isSlotFree({ slot, busy, bufferMs: buffer })).toBe(false);
  });
});

describe('findAvailableSlots', () => {
  const monday = arEpoch(2026, 4, 4, 10, 0);

  it('returns the first N free slots when calendars are completely empty', () => {
    const result = findAvailableSlots({ nowMs: monday, busy: [], count: 2 });
    expect(result).toHaveLength(2);
    // First two slots of next business day: Tue 9:00 + 9:30
    expect(result[0]?.startMs).toBe(arEpoch(2026, 4, 5, 9, 0));
    expect(result[1]?.startMs).toBe(arEpoch(2026, 4, 5, 9, 30));
  });

  it('skips past slots that collide with busy time and returns the next free ones', () => {
    // Block all of Tuesday morning until 11:30
    const busy = [{ startMs: arEpoch(2026, 4, 5, 9, 0), endMs: arEpoch(2026, 4, 5, 11, 30) }];
    const result = findAvailableSlots({ nowMs: monday, busy, count: 2 });
    // Buffer of 15min — first viable slot starts after 11:45 (need slot start - buffer >= 11:30 → start >= 11:45).
    // First 30-min slot whose start >= 11:45 in our half-hour grid is 12:00. (11:30 is on the grid but
    // slot 11:30-12:00 has start 11:30 which is < 11:45 buffered start → blocked.)
    expect(result[0]?.startMs).toBe(arEpoch(2026, 4, 5, 12, 0));
    expect(result[1]?.startMs).toBe(arEpoch(2026, 4, 5, 12, 30));
  });

  it('crosses to next day when current day is fully busy', () => {
    // Block all of Tuesday business hours.
    const busy = [{ startMs: arEpoch(2026, 4, 5, 9, 0), endMs: arEpoch(2026, 4, 5, 19, 0) }];
    const result = findAvailableSlots({ nowMs: monday, busy, count: 2 });
    expect(result[0]?.startMs).toBe(arEpoch(2026, 4, 6, 9, 0)); // Wed 9am
    expect(result[1]?.startMs).toBe(arEpoch(2026, 4, 6, 9, 30));
  });

  it('returns fewer than `count` if the search window is mostly booked', () => {
    // Block all 7 days, except for a single 30-min window on Wednesday at 14:00.
    const busy = [
      { startMs: arEpoch(2026, 4, 5, 9, 0), endMs: arEpoch(2026, 4, 5, 19, 0) }, // Tue
      { startMs: arEpoch(2026, 4, 6, 9, 0), endMs: arEpoch(2026, 4, 6, 13, 45) }, // Wed morning
      { startMs: arEpoch(2026, 4, 6, 14, 30), endMs: arEpoch(2026, 4, 6, 19, 0) }, // Wed afternoon
      { startMs: arEpoch(2026, 4, 7, 9, 0), endMs: arEpoch(2026, 4, 7, 19, 0) }, // Thu
      { startMs: arEpoch(2026, 4, 8, 9, 0), endMs: arEpoch(2026, 4, 8, 19, 0) }, // Fri
      { startMs: arEpoch(2026, 4, 11, 9, 0), endMs: arEpoch(2026, 4, 11, 19, 0) }, // Mon
    ];
    const result = findAvailableSlots({ nowMs: monday, busy, count: 2, windowDays: 7 });
    // Only one slot fits: Wed 14:00 (start 14:00, buffer-pre 13:45 → 13:45 >= 13:45 OK; buffer-post 14:45 → busy starts 14:30 BLOCKED).
    // Actually, 14:00 is blocked because slot+buffer = 14:45 overlaps busy start 14:30. Let me re-check.
    // For slot to be free: slotStart - buffer >= prev_busy_end AND slotEnd + buffer <= next_busy_start.
    // Slot 14:00-14:30 → buffer extends to 13:45 - 14:45. prev busy ends 13:45 (just touches), next busy starts 14:30 (overlaps 14:45 buffer). → blocked.
    // So this configuration has zero free slots. result should be empty.
    expect(result).toHaveLength(0);
  });
});

describe('isSlotOnCandidateGrid', () => {
  // Today = Mon May 4, 2026, 10am AR. Earliest legal slot = Tue May 5, 9am AR.
  const now = arEpoch(2026, 4, 4, 10, 0);

  it('accepts a valid weekday + business hour + half-hour aligned slot', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 5, 11, 0), // Tue 11:00 AR
        nowMs: now,
      }),
    ).toBe(true);
  });

  it('accepts a slot at the boundary 18:30 (last legal start)', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 5, 18, 30),
        nowMs: now,
      }),
    ).toBe(true);
  });

  it('rejects a slot outside business hours (before 9am)', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 5, 7, 20), // 7:20 AR — the actual hallucination case
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('rejects a slot whose end goes past 19:00', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 5, 19, 0), // ends 19:30 — past business hours
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('rejects a Saturday slot', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 9, 10, 0), // Saturday
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('rejects a Sunday slot', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 10, 10, 0), // Sunday
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('rejects a same-day slot (no same-day rule)', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 4, 14, 0), // today 14:00, but earliest is tomorrow
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('rejects a slot not aligned to half-hour grid', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 5, 11, 17), // 11:17 — not :00 or :30
        nowMs: now,
      }),
    ).toBe(false);
  });

  it('rejects a slot beyond the 7-day window', () => {
    expect(
      isSlotOnCandidateGrid({
        slotStartMs: arEpoch(2026, 4, 20, 10, 0), // ~16 days out
        nowMs: now,
        windowDays: 7,
      }),
    ).toBe(false);
  });

  it('every slot generated by generateCandidateSlots passes the grid check (round-trip)', () => {
    const slots = generateCandidateSlots({ nowMs: now, windowDays: 7 });
    for (const s of slots) {
      expect(
        isSlotOnCandidateGrid({ slotStartMs: s.startMs, nowMs: now }),
      ).toBe(true);
    }
  });
});

describe('formatSlotForHumans', () => {
  it('formats a Tuesday 11:00 slot as Spanish weekday + day + month + hour', () => {
    const slot = { startMs: arEpoch(2026, 4, 5, 11, 0), endMs: arEpoch(2026, 4, 5, 11, 30) };
    expect(formatSlotForHumans(slot)).toBe('martes 5 de mayo a las 11:00hs');
  });

  it('handles afternoon slots correctly', () => {
    const slot = { startMs: arEpoch(2026, 4, 6, 16, 30), endMs: arEpoch(2026, 4, 6, 17, 0) };
    expect(formatSlotForHumans(slot)).toBe('miércoles 6 de mayo a las 16:30hs');
  });
});
