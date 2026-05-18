import { createClient } from '@libsql/client';
import { loadEnv } from '../config/env.js';
import { chatwootWriteCircuit } from './chatwoot.js';
import { llmCircuit } from '../server/webhook.js';

function getDb() {
  const env = loadEnv();
  const url = env.MASTRA_DB_URL ?? 'file:./mastra.db';
  return createClient({ url });
}

function todayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface FamaMetrics {
  uptime_ms: number;
  messages_processed_today: number;
  threads_today: number;
  avg_llm_response_ms: number | null;
  nurturing: {
    total: number;
    pending: number;
    escalated: number;
    lost: number;
  };
  circuit_breakers: {
    llm: string;
    chatwoot_write: string;
  };
  collected_at: string;
}

export async function collectMetrics(): Promise<FamaMetrics> {
  const db = getDb();
  const todayMs = todayStartMs();
  const todayIso = new Date(todayMs).toISOString();

  const [processedToday, threadsToday, nurturingRows, avgSpan] = await Promise.all([
    db.execute({
      sql: 'SELECT COUNT(*) as n FROM processed_messages WHERE processed_at >= ?',
      args: [todayMs],
    }),
    db.execute({
      sql: "SELECT COUNT(*) as n FROM mastra_threads WHERE createdAt >= ?",
      args: [todayIso],
    }),
    db.execute('SELECT status, COUNT(*) as n FROM nurturing_conversations GROUP BY status'),
    db.execute(
      "SELECT AVG(CAST(endedAt AS REAL) - CAST(startedAt AS REAL)) as avg_ms FROM mastra_ai_spans WHERE startedAt >= ? AND endedAt IS NOT NULL AND name LIKE '%generate%'",
      [todayIso],
    ),
  ]);

  const nurturing = { total: 0, pending: 0, escalated: 0, lost: 0 };
  for (const row of nurturingRows.rows) {
    const status = row['status'] as string;
    const n = Number(row['n']);
    nurturing.total += n;
    if (status === 'pending') nurturing.pending = n;
    else if (status === 'escalated') nurturing.escalated = n;
    else if (status === 'lost') nurturing.lost = n;
  }

  const rawAvg = avgSpan.rows[0]?.['avg_ms'];
  const avg_llm_response_ms =
    rawAvg !== null && rawAvg !== undefined && !Number.isNaN(Number(rawAvg))
      ? Math.round(Number(rawAvg))
      : null;

  return {
    uptime_ms: Math.round(process.uptime() * 1000),
    messages_processed_today: Number(processedToday.rows[0]?.['n'] ?? 0),
    threads_today: Number(threadsToday.rows[0]?.['n'] ?? 0),
    avg_llm_response_ms,
    nurturing,
    circuit_breakers: {
      llm: llmCircuit.getState(),
      chatwoot_write: chatwootWriteCircuit.getState(),
    },
    collected_at: new Date().toISOString(),
  };
}
