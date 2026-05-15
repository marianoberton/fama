/**
 * Background task tracker — counts in-flight async operations so graceful
 * shutdown can wait for them to finish before exit (v4 Sprint 2).
 *
 * Used by the webhook handler: after responding 202, the LLM processing
 * happens in background. On SIGTERM the shutdown loop polls
 * `pendingBackgroundCount()` until 0 or until the drain timeout elapses.
 */

import { logger } from './logger.js';

let pending = 0;

export function trackBackground<T>(promise: Promise<T>): Promise<T> {
  pending++;
  return promise.finally(() => {
    pending--;
  });
}

export function pendingBackgroundCount(): number {
  return pending;
}

/**
 * Polls until pending reaches 0 or `timeoutMs` elapses. Returns the final
 * pending count (0 if drained, >0 if timed out — caller can log).
 */
export async function waitForBackgroundDrain(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (pending > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (pending > 0) {
    logger.warn(
      { pending, timeoutMs },
      'background-tracker: drain timed out with pending tasks',
    );
  }
  return pending;
}

/** Test-only: reset state between tests. */
export function _resetForTests(): void {
  pending = 0;
}
