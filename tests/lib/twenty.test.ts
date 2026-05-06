import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.CHATWOOT_BASE_URL = 'https://chat.fomo.com.ar';
  process.env.CHATWOOT_ACCOUNT_ID = '1';
  process.env.CHATWOOT_INBOX_ID = '3';
  process.env.CHATWOOT_AGENT_BOT_ID = '2';
  process.env.CHATWOOT_TEAM_ID = '1';
  process.env.CHATWOOT_PATH_TOKEN = 'test-path-token';
});

const { parsePhoneE164, splitName, canAdvanceStage, aliasStage } = await import(
  '../../src/lib/twenty.js'
);

describe('parsePhoneE164', () => {
  it('splits AR E.164 into +54 / AR / national digits', () => {
    expect(parsePhoneE164('+5491132766709')).toEqual({
      primaryPhoneCallingCode: '+54',
      primaryPhoneCountryCode: 'AR',
      primaryPhoneNumber: '91132766709',
    });
  });

  it('strips the leading + for non-AR numbers (no parsing)', () => {
    expect(parsePhoneE164('+15551234567')).toEqual({
      primaryPhoneCallingCode: '',
      primaryPhoneCountryCode: '',
      primaryPhoneNumber: '15551234567',
    });
  });

  it('passes through digits without a leading +', () => {
    expect(parsePhoneE164('5491132766709')).toEqual({
      primaryPhoneCallingCode: '',
      primaryPhoneCountryCode: '',
      primaryPhoneNumber: '5491132766709',
    });
  });

  it('trims whitespace before parsing', () => {
    expect(parsePhoneE164('  +5491132766709  ').primaryPhoneNumber).toBe('91132766709');
  });
});

describe('splitName', () => {
  it('puts a single-token name into firstName, leaves lastName empty', () => {
    expect(splitName('Mariano')).toEqual({ firstName: 'Mariano', lastName: '' });
  });

  it('splits "Mariano Berton" into firstName + lastName', () => {
    expect(splitName('Mariano Berton')).toEqual({
      firstName: 'Mariano',
      lastName: 'Berton',
    });
  });

  it('joins everything after the first token into lastName', () => {
    expect(splitName('María José González Pérez')).toEqual({
      firstName: 'María',
      lastName: 'José González Pérez',
    });
  });

  it('handles extra whitespace', () => {
    expect(splitName('   Juan   Carlos   ')).toEqual({
      firstName: 'Juan',
      lastName: 'Carlos',
    });
  });

  it('returns empty firstName/lastName for blank input', () => {
    expect(splitName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('aliasStage', () => {
  it('maps SCREENING → CONTACTED (legacy alias)', () => {
    expect(aliasStage('SCREENING')).toBe('CONTACTED');
  });

  it('maps CUSTOMER → WON (legacy alias)', () => {
    expect(aliasStage('CUSTOMER')).toBe('WON');
  });

  it('passes canonical stages through unchanged', () => {
    for (const s of ['NEW', 'CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST']) {
      expect(aliasStage(s)).toBe(s);
    }
  });

  it('returns null for unknown / null / empty', () => {
    expect(aliasStage(null)).toBe(null);
    expect(aliasStage('')).toBe(null);
    expect(aliasStage('NONSENSE')).toBe(null);
  });
});

describe('canAdvanceStage', () => {
  it('allows any stage when there is no current stage', () => {
    expect(canAdvanceStage(null, 'NEW')).toBe(true);
    expect(canAdvanceStage(undefined, 'WON')).toBe(true);
    expect(canAdvanceStage('', 'MEETING')).toBe(true);
  });

  it('moves forward through the funnel', () => {
    expect(canAdvanceStage('NEW', 'CONTACTED')).toBe(true);
    expect(canAdvanceStage('CONTACTED', 'MEETING')).toBe(true);
    expect(canAdvanceStage('MEETING', 'PROPOSAL')).toBe(true);
    expect(canAdvanceStage('PROPOSAL', 'WON')).toBe(true);
  });

  it('refuses to go backwards', () => {
    expect(canAdvanceStage('MEETING', 'NEW')).toBe(false);
    expect(canAdvanceStage('PROPOSAL', 'CONTACTED')).toBe(false);
    expect(canAdvanceStage('WON', 'MEETING')).toBe(false);
  });

  it('treats SCREENING as CONTACTED for ordering', () => {
    expect(canAdvanceStage('SCREENING', 'MEETING')).toBe(true);
    expect(canAdvanceStage('SCREENING', 'NEW')).toBe(false);
  });

  it('always allows LOST (terminal can-be-set-anytime)', () => {
    expect(canAdvanceStage('NEW', 'LOST')).toBe(true);
    expect(canAdvanceStage('WON', 'LOST')).toBe(true);
    expect(canAdvanceStage('PROPOSAL', 'LOST')).toBe(true);
  });

  it('never resurrects from LOST', () => {
    expect(canAdvanceStage('LOST', 'NEW')).toBe(false);
    expect(canAdvanceStage('LOST', 'CONTACTED')).toBe(false);
    expect(canAdvanceStage('LOST', 'WON')).toBe(false);
    // LOST → LOST is technically "the same" — allowed by the always-LOST rule.
    expect(canAdvanceStage('LOST', 'LOST')).toBe(true);
  });

  it('blocks moving from WON to anything except WON or LOST', () => {
    expect(canAdvanceStage('WON', 'WON')).toBe(true);
    expect(canAdvanceStage('WON', 'LOST')).toBe(true);
    expect(canAdvanceStage('WON', 'MEETING')).toBe(false);
    expect(canAdvanceStage('CUSTOMER', 'PROPOSAL')).toBe(false); // CUSTOMER is alias of WON
  });

  it('allows same-stage no-op', () => {
    expect(canAdvanceStage('CONTACTED', 'CONTACTED')).toBe(true);
    expect(canAdvanceStage('MEETING', 'MEETING')).toBe(true);
  });
});
