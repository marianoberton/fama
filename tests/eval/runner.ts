/**
 * Eval runner — executes all YAML cases under tests/eval/cases/ against the
 * real Mastra agents (real LLM calls) and reports pass/fail per case.
 *
 * Usage: `npm run eval` (or `tsx tests/eval/runner.ts`).
 *
 * Env required:
 *   - OPENAI_API_KEY
 *   - All CHATWOOT_* (used by tools; mocked at runtime so no real calls)
 *
 * Exit codes:
 *   - 0: all hard cases passed (soft cases may have warned).
 *   - 1: at least one hard case failed.
 *
 * Costs: each turn runs gpt-4o-mini (recepcionista) + possibly gpt-4o
 * (backoffice if delegated). Estimate ~$0.01-0.05 per case. Full suite of
 * ~10 cases ≈ $0.10-0.50 per run.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { RequestContext } from '@mastra/core/di';
import { createClient } from '@libsql/client';
import type { EvalCase, EvalResult } from './types.js';

// Force test mode BEFORE importing anything that touches Mastra. This:
//   - skips background workers (NURTURING, auto-handback, dedup cleanup)
//   - disables observability exporters (Langfuse won't get eval traces)
process.env.NODE_ENV = 'test';

// Mock all Chatwoot network calls — the agents may invoke chatwoot-handoff
// during eval and we don't want real labels / messages going out.
const { setNurturingStoreClientForTests, _truncateForTests } = await import(
  '../../src/lib/nurturing-store.js'
);
await setNurturingStoreClientForTests(createClient({ url: ':memory:' }));
await _truncateForTests();

const fetchOrig = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  // Let OpenAI calls through (we need real LLM responses); stub everything else.
  if (url.includes('api.openai.com')) {
    return fetchOrig(input as RequestInfo, init);
  }
  // Chatwoot, Twenty, Google Calendar: respond 200 with empty JSON so tools
  // succeed without side effects.
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { mastra } = await import('../../src/mastra/index.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, 'cases');

function loadCases(): EvalCase[] {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  return files.map((f) => {
    const raw = readFileSync(path.join(CASES_DIR, f), 'utf8');
    const parsed = parseYaml(raw) as EvalCase;
    if (!parsed.case) throw new Error(`Missing 'case' field in ${f}`);
    return parsed;
  });
}

interface ObservedStep {
  turn: number;
  toolCalls: Array<{ tool: string; args: unknown }>;
  delegatedTo: string[];
  finalText: string;
}

function extractToolCalls(reply: unknown): Array<{ tool: string; args: unknown }> {
  if (!reply || typeof reply !== 'object') return [];
  const steps = (reply as Record<string, unknown>)['steps'];
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s: unknown) => {
    const step = s as Record<string, unknown>;
    if (!Array.isArray(step['toolCalls'])) return [];
    return step['toolCalls'].map((tc: unknown) => {
      const t = tc as Record<string, unknown>;
      return { tool: String(t['toolName'] ?? 'unknown'), args: t['args'] };
    });
  });
}

function extractDelegations(reply: unknown): string[] {
  // Sub-agent delegations show up as tool calls with the sub-agent's id as toolName.
  const calls = extractToolCalls(reply);
  const known = new Set(['backoffice', 'agendador']);
  return calls.filter((c) => known.has(c.tool)).map((c) => c.tool);
}

async function runCase(c: EvalCase): Promise<EvalResult> {
  const t0 = Date.now();
  const observed: ObservedStep[] = [];
  const recepcionista = mastra.getAgent('recepcionista');

  // Fake conversation id per case so Memory threads don't collide between cases.
  const conversationId = 900_000 + Math.floor(Math.random() * 100_000);
  const contactId = 800_000 + Math.floor(Math.random() * 100_000);
  const threadKey = `eval-${c.case}-${conversationId}`;

  for (let i = 0; i < c.turns.length; i++) {
    const userMsg = c.turns[i]!;
    const requestContext = new RequestContext();
    requestContext.set('conversationId', conversationId);
    requestContext.set('contactId', contactId);
    requestContext.set('phone', '+5491100000000');
    requestContext.set('contactName', 'Eval Tester');

    let reply: unknown;
    try {
      reply = await recepcionista.generate(userMsg, {
        memory: { thread: threadKey, resource: `eval-contact-${contactId}` },
        maxSteps: 8,
        requestContext,
      });
    } catch (err) {
      return {
        case: c.case,
        category: c.category,
        hard: c.hard,
        pass: false,
        failures: [`Turn ${i + 1} crashed: ${(err as Error).message}`],
        observedToolCalls: [],
        observedResponses: [],
        durationMs: Date.now() - t0,
      };
    }

    const toolCalls = extractToolCalls(reply);
    const delegatedTo = extractDelegations(reply);
    const finalText = String((reply as Record<string, unknown>)['text'] ?? '');
    observed.push({ turn: i, toolCalls, delegatedTo, finalText });
  }

  // Aggregate observations across all turns.
  const allToolCalls = observed.flatMap((s) => s.toolCalls);
  const allDelegations = new Set(observed.flatMap((s) => s.delegatedTo));
  const finalResponse = observed[observed.length - 1]?.finalText ?? '';

  const failures: string[] = [];

  // 1. toolsCalled
  for (const expectedTool of c.expect.toolsCalled ?? []) {
    if (!allToolCalls.some((tc) => tc.tool === expectedTool)) {
      failures.push(`Expected tool '${expectedTool}' was never called`);
    }
  }

  // 2. delegatedTo
  for (const expectedAgent of c.expect.delegatedTo ?? []) {
    if (!allDelegations.has(expectedAgent)) {
      failures.push(`Expected delegation to '${expectedAgent}' did not happen`);
    }
  }

  // 3. finalResponseMatches
  for (const pattern of c.expect.finalResponseMatches ?? []) {
    if (!new RegExp(pattern, 'i').test(finalResponse)) {
      failures.push(
        `Final response did not match /${pattern}/i. Got: "${finalResponse.slice(0, 200)}"`,
      );
    }
  }

  // 4. finalResponseDoesNotMatch
  for (const pattern of c.expect.finalResponseDoesNotMatch ?? []) {
    if (new RegExp(pattern, 'i').test(finalResponse)) {
      failures.push(
        `Final response illegally matched /${pattern}/i (hallucination?). Got: "${finalResponse.slice(0, 200)}"`,
      );
    }
  }

  // 5. toolArgsMatch
  for (const [tool, expectedArgs] of Object.entries(c.expect.toolArgsMatch ?? {})) {
    const calls = allToolCalls.filter((tc) => tc.tool === tool);
    if (calls.length === 0) {
      failures.push(`Cannot check toolArgsMatch for '${tool}' — tool was never called`);
      continue;
    }
    const anyMatch = calls.some((call) => {
      const args = (call.args ?? {}) as Record<string, unknown>;
      return Object.entries(expectedArgs).every(([k, v]) => args[k] === v);
    });
    if (!anyMatch) {
      failures.push(
        `No call to '${tool}' matched expected args ${JSON.stringify(expectedArgs)}. Got: ${JSON.stringify(calls.map((c) => c.args))}`,
      );
    }
  }

  return {
    case: c.case,
    category: c.category,
    hard: c.hard,
    pass: failures.length === 0,
    failures,
    observedToolCalls: observed.flatMap((s) =>
      s.toolCalls.map((tc) => ({ turn: s.turn, tool: tc.tool, args: tc.args })),
    ),
    observedResponses: observed.map((s) => s.finalText.slice(0, 200)),
    durationMs: Date.now() - t0,
  };
}

function printResult(r: EvalResult): void {
  const icon = r.pass ? '✓' : r.hard ? '✗' : '⚠';
  const label = `${icon} ${r.category}/${r.case} (${r.durationMs}ms)`;
  if (r.pass) {
    console.log(label);
    return;
  }
  console.log(label);
  for (const f of r.failures) console.log(`    - ${f}`);
  console.log('    Final responses by turn:');
  r.observedResponses.forEach((resp, i) => {
    console.log(`      [${i}] ${resp}`);
  });
  console.log('    Tool calls observed:');
  r.observedToolCalls.forEach((tc) => {
    console.log(`      turn ${tc.turn}: ${tc.tool}(${JSON.stringify(tc.args)?.slice(0, 120)}...)`);
  });
}

async function main(): Promise<void> {
  const cases = loadCases();
  console.log(`Running ${cases.length} eval case(s)...\n`);

  const results: EvalResult[] = [];
  for (const c of cases) {
    const r = await runCase(c);
    printResult(r);
    results.push(r);
  }

  const hardFails = results.filter((r) => !r.pass && r.hard);
  const softFails = results.filter((r) => !r.pass && !r.hard);
  const passes = results.filter((r) => r.pass);

  console.log(
    `\nSummary: ${passes.length}/${results.length} passed, ${hardFails.length} HARD failures, ${softFails.length} soft warnings`,
  );

  process.exit(hardFails.length > 0 ? 1 : 0);
}

await main();
