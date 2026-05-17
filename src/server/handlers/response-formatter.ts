export interface HandlerOutcome {
  status: 200 | 202 | 401 | 500;
  body: Record<string, unknown>;
}

export const Responses = {
  rejected: (reason: string): HandlerOutcome => ({ status: 401, body: { error: reason } }),
  ignored: (reason: string): HandlerOutcome => ({ status: 200, body: { ignored: reason } }),
  extractionFailed: (): HandlerOutcome => ({
    status: 500,
    body: { error: 'message_extraction_failed' },
  }),
  duplicate: (): HandlerOutcome => ({ status: 200, body: { ignored: 'duplicate_message' } }),
  received: (): HandlerOutcome => ({ status: 202, body: { received: true } }),
  welcome: (): HandlerOutcome => ({ status: 202, body: { received: true, welcome: true } }),
  agentFailed: (): HandlerOutcome => ({ status: 500, body: { error: 'agent_or_post_failed' } }),
  circuitOpen: (): HandlerOutcome => ({
    status: 202,
    body: { received: true, llmCircuitOpen: true },
  }),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns true if any tool in the agent's response — direct or nested via
 * sub-agent delegation — reported `replyHandled: true`. The chatwoot-handoff
 * tool sets this when it has posted the public ack, so we can skip posting
 * the supervisor's final text and avoid sending a duplicate message.
 */
export function handoffAlreadyPostedAck(reply: unknown): boolean {
  function recurse(toolResults: unknown): boolean {
    if (!Array.isArray(toolResults)) return false;
    for (const tr of toolResults) {
      if (!isObject(tr)) continue;
      const payload = isObject(tr['payload']) ? tr['payload'] : null;
      const result = payload && isObject(payload['result']) ? payload['result'] : null;
      if (result && result['replyHandled'] === true) return true;
      if (result && recurse(result['subAgentToolResults'])) return true;
    }
    return false;
  }
  if (!isObject(reply)) return false;
  if (recurse(reply['toolResults'])) return true;
  const steps = reply['steps'];
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (isObject(step) && recurse(step['toolResults'])) return true;
    }
  }
  return false;
}
