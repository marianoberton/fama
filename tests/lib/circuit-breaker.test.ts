import { describe, it, expect } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  withCircuit,
} from '../../src/lib/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts in closed state and allows traffic', () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      failureWindowMs: 60_000,
      recoveryMs: 5 * 60_000,
    });
    expect(cb.getState()).toBe('closed');
    expect(cb.isOpen()).toBe(false);
  });

  it('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      failureWindowMs: 60_000,
      recoveryMs: 5 * 60_000,
    });
    const t = 1000;
    cb.recordFailure(t);
    cb.recordFailure(t);
    expect(cb.getState()).toBe('closed'); // 2 failures, threshold=3 → still closed
    cb.recordFailure(t);
    expect(cb.getState()).toBe('open');
    expect(cb.isOpen(t)).toBe(true);
  });

  it('failures outside the window do NOT count toward threshold', () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      failureWindowMs: 60_000,
      recoveryMs: 5 * 60_000,
    });
    cb.recordFailure(0);
    cb.recordFailure(30_000);
    // After window expires (>60s), the first failure should drop out.
    cb.recordFailure(70_000); // only this + 30_000 are in window → 2 failures
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(80_000); // now 3 in window → open
    expect(cb.getState()).toBe('open');
  });

  it('a single success resets the failure counter', () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      failureWindowMs: 60_000,
      recoveryMs: 5 * 60_000,
    });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed'); // only 2 failures since the success
  });

  it('open → half-open after recoveryMs elapses', () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      failureWindowMs: 60_000,
      recoveryMs: 5_000,
    });
    cb.recordFailure(0);
    cb.recordFailure(100);
    expect(cb.getState()).toBe('open');
    expect(cb.isOpen(2000)).toBe(true); // still open, recoveryMs not elapsed
    expect(cb.isOpen(6000)).toBe(false); // 6s > 5s recovery → half-open
    expect(cb.getState()).toBe('half-open');
  });

  it('half-open success → closed', () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      failureWindowMs: 60_000,
      recoveryMs: 5_000,
    });
    cb.recordFailure(0);
    cb.recordFailure(100);
    cb.isOpen(6000); // transitions to half-open
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('half-open failure → open again with fresh recovery window', () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      failureWindowMs: 60_000,
      recoveryMs: 5_000,
    });
    cb.recordFailure(0);
    cb.recordFailure(100);
    cb.isOpen(6000); // half-open
    cb.recordFailure(6500);
    expect(cb.getState()).toBe('open');
    expect(cb.isOpen(7000)).toBe(true); // still open
    // Need to wait another full recovery window from 6500
    expect(cb.isOpen(11_600)).toBe(false); // 11600 - 6500 = 5100 > 5000
  });
});

describe('withCircuit', () => {
  it('runs the function and records success when it resolves', async () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      failureWindowMs: 60_000,
      recoveryMs: 5_000,
    });
    cb.recordFailure();
    const result = await withCircuit(cb, async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('closed'); // success reset the failure counter
  });

  it('records failure and re-throws when fn throws', async () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 2,
      failureWindowMs: 60_000,
      recoveryMs: 5_000,
    });
    await expect(withCircuit(cb, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withCircuit(cb, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(cb.getState()).toBe('open');
  });

  it('short-circuits with CircuitOpenError when the breaker is open', async () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      failureWindowMs: 60_000,
      recoveryMs: 5_000,
    });
    cb.recordFailure();
    let called = false;
    await expect(
      withCircuit(cb, async () => {
        called = true;
        return 'should not run';
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });
});
