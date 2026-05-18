import { describe, it, expect } from 'vitest';
import {
  detectKnownCustomer,
  formatKnownCustomerContext,
} from '../../src/lib/known-customer.js';

const NOW = Date.UTC(2026, 4, 3, 12, 0, 0); // 2026-05-03T12:00:00Z

describe('detectKnownCustomer', () => {
  it('returns known=false when conversations is empty', () => {
    expect(
      detectKnownCustomer({ conversations: [], now: NOW, inboxIds: [3] }),
    ).toEqual({ known: false, count: 0, lastConversationAt: null });
  });

  it('filters by inbox id', () => {
    const out = detectKnownCustomer({
      conversations: [
        { id: 1, inboxId: 99, messageCount: 5, lastActivityAtMs: NOW - 86_400_000 },
      ],
      now: NOW,
      inboxIds: [3],
    });
    expect(out.known).toBe(false);
  });

  it('filters by minMessages (default 2)', () => {
    const out = detectKnownCustomer({
      conversations: [
        { id: 1, inboxId: 3, messageCount: 1, lastActivityAtMs: NOW - 86_400_000 },
      ],
      now: NOW,
      inboxIds: [3],
    });
    expect(out.known).toBe(false);
  });

  it('filters by windowDays (default 30)', () => {
    const out = detectKnownCustomer({
      conversations: [
        {
          id: 1,
          inboxId: 3,
          messageCount: 5,
          lastActivityAtMs: NOW - 31 * 86_400_000,
        },
      ],
      now: NOW,
      inboxIds: [3],
    });
    expect(out.known).toBe(false);
  });

  it('excludes the current conversation when excludeConversationId is set', () => {
    const out = detectKnownCustomer({
      conversations: [
        { id: 4248, inboxId: 3, messageCount: 5, lastActivityAtMs: NOW - 86_400_000 },
      ],
      now: NOW,
      inboxIds: [3],
      excludeConversationId: 4248,
    });
    expect(out.known).toBe(false);
  });

  it('returns known=true with the most recent lastConversationAt', () => {
    const out = detectKnownCustomer({
      conversations: [
        { id: 1, inboxId: 3, messageCount: 4, lastActivityAtMs: NOW - 10 * 86_400_000 },
        { id: 2, inboxId: 3, messageCount: 6, lastActivityAtMs: NOW - 3 * 86_400_000 },
      ],
      now: NOW,
      inboxIds: [3],
    });
    expect(out).toEqual({
      known: true,
      count: 2,
      lastConversationAt: NOW - 3 * 86_400_000,
    });
  });
});

describe('formatKnownCustomerContext', () => {
  it('formats singular count and "hace N días" relative date', () => {
    const ctx = formatKnownCustomerContext({
      signal: { known: true, count: 1, lastConversationAt: NOW - 5 * 86_400_000 },
      now: NOW,
    });
    expect(ctx).toContain('[CONTEXTO_SISTEMA]');
    expect(ctx).toContain('1 conversación previa');
    expect(ctx).toContain('hace 5 días');
    expect(ctx).toContain('[/CONTEXTO_SISTEMA]');
  });

  it('formats plural count', () => {
    const ctx = formatKnownCustomerContext({
      signal: { known: true, count: 3, lastConversationAt: NOW - 86_400_000 },
      now: NOW,
    });
    expect(ctx).toContain('3 conversaciones previas');
    expect(ctx).toContain('hace 1 día');
  });

  it('throws when called with non-known signal', () => {
    expect(() =>
      formatKnownCustomerContext({
        signal: { known: false, count: 0, lastConversationAt: null },
        now: NOW,
      }),
    ).toThrow();
  });
});
