/**
 * Generic circuit breaker — fails fast after N consecutive failures within
 * a rolling window. Reused for the OpenAI / LLM circuit and the Chatwoot API
 * circuit (v4 Sprint 2).
 *
 * States:
 *   - closed: normal operation, failures counted.
 *   - open: requests rejected without attempt for `recoveryMs`.
 *   - half-open: one trial request allowed. Success → closed. Failure → open.
 *
 * No timers, no background work: state transitions happen on each
 * `isOpen()` / `recordFailure()` / `recordSuccess()` call. Safe to use from
 * any context (tests, request handlers, workers).
 */

import { logger } from './logger.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Identifier for logs. */
  name: string;
  /** Consecutive failures within failureWindowMs that trip the circuit. */
  failureThreshold: number;
  /** Sliding window for counting failures, in ms. */
  failureWindowMs: number;
  /** Time the circuit stays open before allowing a trial request. */
  recoveryMs: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /**
   * Returns true if calls should be short-circuited. Transitions from open to
   * half-open if the recovery window has elapsed.
   */
  isOpen(now = Date.now()): boolean {
    if (this.state === 'closed') return false;
    if (this.state === 'half-open') return false; // allow the trial call

    // state === 'open'
    if (this.openedAt !== null && now - this.openedAt >= this.opts.recoveryMs) {
      this.state = 'half-open';
      logger.info(
        { name: this.opts.name },
        'circuit-breaker: half-open (allowing trial request)',
      );
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failureTimestamps = [];
    if (this.state !== 'closed') {
      logger.info(
        { name: this.opts.name, previousState: this.state },
        'circuit-breaker: closed (success after recovery)',
      );
      this.state = 'closed';
      this.openedAt = null;
    }
  }

  recordFailure(now = Date.now()): void {
    // Half-open trial failed → straight back to open with a fresh window.
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      this.failureTimestamps = [now];
      logger.warn(
        { name: this.opts.name },
        'circuit-breaker: open (half-open trial failed)',
      );
      return;
    }

    // Drop failures outside the rolling window.
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => now - t < this.opts.failureWindowMs,
    );
    this.failureTimestamps.push(now);

    if (this.failureTimestamps.length >= this.opts.failureThreshold) {
      const wasOpen = this.state === 'open';
      this.state = 'open';
      this.openedAt = now;
      if (!wasOpen) {
        logger.warn(
          {
            name: this.opts.name,
            failures: this.failureTimestamps.length,
            windowMs: this.opts.failureWindowMs,
            recoveryMs: this.opts.recoveryMs,
          },
          'circuit-breaker: opened',
        );
      }
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  get circuitName(): string {
    return this.opts.name;
  }

  /** For tests + debug. */
  reset(): void {
    this.state = 'closed';
    this.failureTimestamps = [];
    this.openedAt = null;
  }
}

/**
 * Convenience wrapper: run `fn` through a circuit. If open, throws
 * `CircuitOpenError`. On success/failure, records the result on the breaker.
 */
export class CircuitOpenError extends Error {
  constructor(public readonly circuitName: string) {
    super(`Circuit '${circuitName}' is open — short-circuited`);
    this.name = 'CircuitOpenError';
  }
}

export async function withCircuit<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
): Promise<T> {
  if (breaker.isOpen()) {
    throw new CircuitOpenError(breaker.circuitName);
  }
  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (err) {
    breaker.recordFailure();
    throw err;
  }
}
