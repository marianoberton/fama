import { describe, it, expect, beforeEach } from 'vitest';
import {
  trackBackground,
  pendingBackgroundCount,
  waitForBackgroundDrain,
  _resetForTests,
} from '../../src/lib/background-tracker.js';

beforeEach(() => {
  _resetForTests();
});

describe('background-tracker', () => {
  it('increments pending count while promise is in flight, decrements when resolved', async () => {
    expect(pendingBackgroundCount()).toBe(0);

    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    const tracked = trackBackground(p);

    expect(pendingBackgroundCount()).toBe(1);
    resolve();
    await tracked;
    expect(pendingBackgroundCount()).toBe(0);
  });

  it('decrements even when the tracked promise rejects', async () => {
    let reject!: (e: Error) => void;
    const p = new Promise<void>((_, r) => { reject = r; });
    const tracked = trackBackground(p);

    expect(pendingBackgroundCount()).toBe(1);
    reject(new Error('boom'));
    await expect(tracked).rejects.toThrow('boom');
    expect(pendingBackgroundCount()).toBe(0);
  });

  it('tracks multiple parallel promises', async () => {
    const resolvers: Array<() => void> = [];
    const promises = [0, 1, 2].map(() => {
      const p = new Promise<void>((r) => { resolvers.push(r); });
      return trackBackground(p);
    });

    expect(pendingBackgroundCount()).toBe(3);
    resolvers[0]!();
    await promises[0];
    expect(pendingBackgroundCount()).toBe(2);
    resolvers[1]!();
    resolvers[2]!();
    await Promise.all(promises);
    expect(pendingBackgroundCount()).toBe(0);
  });

  it('waitForBackgroundDrain returns 0 when all tasks finish before timeout', async () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    const tracked = trackBackground(p);

    setTimeout(() => resolve(), 50);
    const remaining = await waitForBackgroundDrain(1000);
    expect(remaining).toBe(0);
    await tracked;
  });

  it('waitForBackgroundDrain returns >0 when timeout elapses', async () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    trackBackground(p);

    const remaining = await waitForBackgroundDrain(300);
    expect(remaining).toBe(1);
    // Cleanup so afterEach doesn't see lingering state.
    resolve();
  });
});
