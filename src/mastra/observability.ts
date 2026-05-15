/**
 * Observability setup for FAMA (v4 Sprint 1).
 *
 * Wires Mastra's native observability with the Langfuse exporter. When Langfuse
 * env vars are present, every `agent.generate()` + sub-agent delegation + tool
 * call gets exported as a trace with the conversationId as sessionId.
 *
 * If LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are empty (typical for tests
 * and dev), only the DefaultExporter is registered — traces live in the
 * embedded Mastra Studio at /studio.
 */

import { Observability, DefaultExporter } from '@mastra/observability';
import { LangfuseExporter } from '@mastra/langfuse';
import type { ObservabilityExporter } from '@mastra/core/observability';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';

export function buildObservability(): Observability | undefined {
  const env = loadEnv();

  // In test mode skip observability entirely — exporters that try to hit
  // storage or external HTTP would pollute assertions and slow tests down.
  if (env.NODE_ENV === 'test') return undefined;

  const exporters: ObservabilityExporter[] = [new DefaultExporter()];

  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    exporters.push(
      new LangfuseExporter({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_BASE_URL || undefined,
        environment: env.NODE_ENV,
      }),
    );
    logger.info(
      {
        baseUrl: env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
        environment: env.NODE_ENV,
      },
      'observability: Langfuse exporter registered',
    );
  } else {
    logger.info(
      'observability: Langfuse not configured (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY empty) — traces only in DefaultExporter / Studio',
    );
  }

  return new Observability({
    configs: {
      default: {
        serviceName: 'fama',
        exporters,
        // Extract these keys from the RequestContext as span metadata so
        // Langfuse can group spans by session (conversationId) and user
        // (contactId). The Langfuse exporter auto-maps:
        //   mastra.metadata.sessionId → session.id
        //   mastra.metadata.userId    → user.id
        requestContextKeys: [
          'conversationId',
          'contactId',
          'phone',
          'contactName',
          'sessionId',
          'userId',
        ],
        // Default sampling is 'always' — fine for FAMA's volume (~100s of
        // messages/day max). If volume grows, switch to ratio sampling.
      },
    },
  });
}
