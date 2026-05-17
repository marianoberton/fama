import { describe, it, expect } from 'vitest';
import { Responses, handoffAlreadyPostedAck } from '../../../src/server/handlers/response-formatter.js';

describe('Responses factory', () => {
  it('rejected returns 401 with error key', () => {
    expect(Responses.rejected('bad_token')).toEqual({
      status: 401,
      body: { error: 'bad_token' },
    });
  });

  it('ignored returns 200 with ignored key', () => {
    expect(Responses.ignored('not_pending')).toEqual({
      status: 200,
      body: { ignored: 'not_pending' },
    });
  });

  it('extractionFailed returns 500', () => {
    expect(Responses.extractionFailed()).toEqual({
      status: 500,
      body: { error: 'message_extraction_failed' },
    });
  });

  it('duplicate returns 200 with duplicate reason', () => {
    expect(Responses.duplicate()).toEqual({
      status: 200,
      body: { ignored: 'duplicate_message' },
    });
  });

  it('received returns 202 with received:true', () => {
    expect(Responses.received()).toEqual({ status: 202, body: { received: true } });
  });

  it('welcome returns 202 with welcome:true', () => {
    expect(Responses.welcome()).toEqual({ status: 202, body: { received: true, welcome: true } });
  });

  it('agentFailed returns 500', () => {
    expect(Responses.agentFailed()).toEqual({
      status: 500,
      body: { error: 'agent_or_post_failed' },
    });
  });

  it('circuitOpen returns 202 with llmCircuitOpen:true', () => {
    expect(Responses.circuitOpen()).toEqual({
      status: 202,
      body: { received: true, llmCircuitOpen: true },
    });
  });
});

describe('handoffAlreadyPostedAck', () => {
  it('returns false for null/undefined/non-object', () => {
    expect(handoffAlreadyPostedAck(null)).toBe(false);
    expect(handoffAlreadyPostedAck(undefined)).toBe(false);
    expect(handoffAlreadyPostedAck('string')).toBe(false);
    expect(handoffAlreadyPostedAck(42)).toBe(false);
  });

  it('returns false when toolResults is absent', () => {
    expect(handoffAlreadyPostedAck({ text: 'hello', steps: [] })).toBe(false);
  });

  it('returns false when toolResults is empty', () => {
    expect(handoffAlreadyPostedAck({ toolResults: [], steps: [] })).toBe(false);
  });

  it('returns true when top-level toolResults contains replyHandled:true', () => {
    const reply = {
      toolResults: [
        {
          payload: {
            result: { replyHandled: true, success: true },
          },
        },
      ],
      steps: [],
    };
    expect(handoffAlreadyPostedAck(reply)).toBe(true);
  });

  it('returns false when replyHandled is false', () => {
    const reply = {
      toolResults: [
        {
          payload: {
            result: { replyHandled: false },
          },
        },
      ],
      steps: [],
    };
    expect(handoffAlreadyPostedAck(reply)).toBe(false);
  });

  it('returns true when replyHandled is nested in subAgentToolResults', () => {
    const reply = {
      toolResults: [
        {
          payload: {
            result: {
              replyHandled: false,
              subAgentToolResults: [
                {
                  payload: {
                    result: { replyHandled: true },
                  },
                },
              ],
            },
          },
        },
      ],
      steps: [],
    };
    expect(handoffAlreadyPostedAck(reply)).toBe(true);
  });

  it('returns true when replyHandled is found in steps[].toolResults', () => {
    const reply = {
      toolResults: [],
      steps: [
        {
          toolResults: [
            {
              payload: {
                result: { replyHandled: true },
              },
            },
          ],
        },
      ],
    };
    expect(handoffAlreadyPostedAck(reply)).toBe(true);
  });

  it('returns false when steps is not an array', () => {
    expect(handoffAlreadyPostedAck({ toolResults: [], steps: 'not-an-array' })).toBe(false);
  });
});
