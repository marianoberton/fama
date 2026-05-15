/**
 * Eval case spec — declarative YAML format for canonical conversations.
 *
 * Each `.yaml` file in `tests/eval/cases/` describes:
 *   - A sequence of customer messages (`turns`).
 *   - Expectations about the agent's behavior:
 *       - which tools were called
 *       - which sub-agents were delegated to
 *       - regex matches / non-matches on the final response
 *   - Whether failure should block CI merge (`hard: true`) or just warn.
 *
 * Runner: `tests/eval/runner.ts` (executed via `npm run eval`).
 */

export interface EvalCase {
  /** Unique slug for this case. Used in logs + CI output. */
  case: string;
  /** Human-readable description of the canonical scenario. */
  description: string;
  /** Classification — for grouping the report. */
  category: 'arquetipo' | 'excepcion' | 'edge';
  /** If true, failure exits non-zero (blocks PR merge). */
  hard: boolean;
  /** Sequence of customer messages, in order. The agent runs once per turn. */
  turns: string[];
  /** Expectations evaluated against the FULL conversation (all turns). */
  expect: {
    /** Tools that MUST have been called at least once across all turns. */
    toolsCalled?: string[];
    /** Sub-agents that MUST have been delegated to at least once. */
    delegatedTo?: string[];
    /** Regex(es) that the final agent reply MUST match (case-insensitive). */
    finalResponseMatches?: string[];
    /**
     * Regex(es) that the final agent reply MUST NOT match. Useful for
     * catching hallucinated confirmations (e.g. "quedó agendada" when no
     * tool was actually called).
     */
    finalResponseDoesNotMatch?: string[];
    /**
     * Tool args matchers — for each tool, partial deep-match against args.
     * Example: { 'upsert-twenty-lead': { stage: 'MEETING', arquetipo: 'caliente' } }
     */
    toolArgsMatch?: Record<string, Record<string, unknown>>;
  };
}

export interface EvalResult {
  case: string;
  category: EvalCase['category'];
  hard: boolean;
  pass: boolean;
  /** Per-assertion outcomes — empty when all passed. */
  failures: string[];
  /** Per-turn observed tool calls (for debugging failures). */
  observedToolCalls: Array<{ turn: number; tool: string; args: unknown }>;
  /** Per-turn final response (truncated). */
  observedResponses: string[];
  /** Total elapsed ms. */
  durationMs: number;
}
