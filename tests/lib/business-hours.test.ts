import { describe, it, expect } from 'vitest';
import {
  isInArgentinaBusinessHours,
  nextArgentinaBusinessTime,
} from '../../src/lib/business-hours.js';

/** Build a Date for the given AR local hour. AR is UTC-3, so AR H == UTC H+3. */
function arDate(year: number, month: number, day: number, arHour: number, arMin = 0): Date {
  // month is 1-based here for readability; Date.UTC takes 0-based.
  return new Date(Date.UTC(year, month - 1, day, arHour + 3, arMin, 0));
}

describe('isInArgentinaBusinessHours', () => {
  it('returns true at AR 09:00 (start of window, inclusive)', () => {
    expect(isInArgentinaBusinessHours(arDate(2026, 5, 4, 9, 0))).toBe(true);
  });

  it('returns true at AR 18:59', () => {
    expect(isInArgentinaBusinessHours(arDate(2026, 5, 4, 18, 59))).toBe(true);
  });

  it('returns false at AR 19:00 (end of window, exclusive)', () => {
    expect(isInArgentinaBusinessHours(arDate(2026, 5, 4, 19, 0))).toBe(false);
  });

  it('returns false at AR 08:59', () => {
    expect(isInArgentinaBusinessHours(arDate(2026, 5, 4, 8, 59))).toBe(false);
  });

  it('returns false at AR 03:00 (middle of the night)', () => {
    expect(isInArgentinaBusinessHours(arDate(2026, 5, 4, 3, 0))).toBe(false);
  });

  it('returns false at AR 23:00', () => {
    expect(isInArgentinaBusinessHours(arDate(2026, 5, 4, 23, 0))).toBe(false);
  });

  it('returns true at AR noon', () => {
    expect(isInArgentinaBusinessHours(arDate(2026, 5, 4, 12, 0))).toBe(true);
  });
});

describe('nextArgentinaBusinessTime', () => {
  it('returns the same instant when already inside the window', () => {
    const inside = arDate(2026, 5, 4, 14, 30);
    const next = nextArgentinaBusinessTime(inside);
    expect(next.getTime()).toBe(inside.getTime());
  });

  it('jumps to today 09:00 AR when called before opening', () => {
    const before = arDate(2026, 5, 4, 7, 0);
    const next = nextArgentinaBusinessTime(before);
    expect(next.getTime()).toBe(arDate(2026, 5, 4, 9, 0).getTime());
  });

  it('jumps to tomorrow 09:00 AR when called after closing', () => {
    const after = arDate(2026, 5, 4, 21, 0);
    const next = nextArgentinaBusinessTime(after);
    expect(next.getTime()).toBe(arDate(2026, 5, 5, 9, 0).getTime());
  });
});
