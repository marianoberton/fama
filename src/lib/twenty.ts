import { loadEnv } from '../config/env.js';
import { logger } from './logger.js';

// === ERRORS ===

export class TwentyNotConfiguredError extends Error {
  constructor() {
    super(
      'TWENTY_API_URL/TWENTY_API_KEY are empty — set them in .env to enable CRM upserts',
    );
    this.name = 'TwentyNotConfiguredError';
  }
}

export class TwentyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly bodyPreview: string,
  ) {
    super(`Twenty API error: ${status} ${statusText} — ${bodyPreview.slice(0, 300)}`);
    this.name = 'TwentyApiError';
  }
}

// === CONFIG ===

export interface TwentyConfig {
  baseUrl: string;
  apiKey: string;
  /** May be empty — when empty, Company creation skips owner assignment. */
  ownerUserId: string;
}

export function isTwentyConfigured(): boolean {
  const env = loadEnv();
  return !!env.TWENTY_API_URL && !!env.TWENTY_API_KEY;
}

export function requireTwentyConfig(): TwentyConfig {
  const env = loadEnv();
  if (!env.TWENTY_API_URL || !env.TWENTY_API_KEY) {
    throw new TwentyNotConfiguredError();
  }
  return {
    baseUrl: env.TWENTY_API_URL.replace(/\/$/, ''),
    apiKey: env.TWENTY_API_KEY,
    ownerUserId: env.TWENTY_OWNER_USER_ID,
  };
}

// === DOMAIN TYPES ===

export const TWENTY_STAGES = ['NEW', 'CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'] as const;
export type TwentyStage = (typeof TWENTY_STAGES)[number];

export type TwentyArquetipo = 'CALIENTE' | 'A_EXPLORAR' | 'SIN_CLARIDAD' | 'NO_LEAD';
export type TwentyException =
  | 'PEDIDO_HUMANO'
  | 'CONSULTORIA'
  | 'URGENCIA'
  | 'RECLAMO'
  | 'DEMO';
export type TwentySourceChannel =
  | 'WEBSITE'
  | 'WHATSAPP'
  | 'INSTAGRAM'
  | 'LINKEDIN'
  | 'REFERRAL'
  | 'EMAIL'
  | 'ADS'
  | 'OTHER';

export interface PersonRecord {
  id: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  emails?: { primaryEmail?: string | null } | null;
  phones?: {
    primaryPhoneNumber?: string | null;
    primaryPhoneCountryCode?: string | null;
    primaryPhoneCallingCode?: string | null;
  } | null;
  companyId?: string | null;
  whatsappUrl?: string | null;
  firstContactAt?: string | null;
  lastContactAt?: string | null;
  messageCount?: number | null;
}

export interface CompanyRecord {
  id: string;
  name?: string | null;
  accountOwnerId?: string | null;
}

export interface OpportunityRecord {
  id: string;
  name?: string | null;
  /** Twenty also has legacy SCREENING/CUSTOMER values; normalise via aliasStage(). */
  stage: string;
  pointOfContactId?: string | null;
  companyId?: string | null;
  sourceChannel?: TwentySourceChannel | null;
  arquetipo?: TwentyArquetipo | null;
  exception?: TwentyException | null;
}

// === HTTP ===

interface TwentyFetchOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path under the REST base URL. Must start with `/`. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /**
   * Number of retries on 5xx / network errors. Default 3 (0 = no retry).
   * 4xx never retries — those are bugs in our request, not flakiness.
   */
  retries?: number;
}

const RETRY_DELAYS_MS = [5000, 10000, 15000];

async function twentyFetch<T = unknown>(opts: TwentyFetchOptions): Promise<T> {
  const config = requireTwentyConfig();
  const url = new URL(config.baseUrl + opts.path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const maxRetries = opts.retries ?? 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
      await sleep(delay);
    }
    try {
      const res = await fetch(url.toString(), {
        method: opts.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json().catch(() => ({}))) as T;
      }

      const text = await res.text().catch(() => '');
      // 4xx → don't retry; surface immediately so the tool can log + stop.
      if (res.status >= 400 && res.status < 500) {
        throw new TwentyApiError(res.status, res.statusText, text);
      }
      // 5xx → retry
      lastErr = new TwentyApiError(res.status, res.statusText, text);
      logger.warn(
        { attempt, status: res.status, path: opts.path },
        'twenty: 5xx — will retry',
      );
      continue;
    } catch (err) {
      // Re-throw 4xx as-is — never retry.
      if (err instanceof TwentyApiError && err.status >= 400 && err.status < 500) {
        throw err;
      }
      lastErr = err;
      logger.warn(
        { attempt, err: (err as Error).message, path: opts.path },
        'twenty: network/transient error — will retry',
      );
    }
  }

  throw lastErr ?? new Error('twenty: retries exhausted with no captured error');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// === LOOKUPS ===

/**
 * Looks up a Person by phone. Twenty stores phones split into calling code +
 * national number, so we search by the national-number suffix (most stable
 * representation across input shapes).
 */
export async function findPersonByPhone(phone: string): Promise<PersonRecord | null> {
  const { primaryPhoneNumber } = parsePhoneE164(phone);
  const json = await twentyFetch<{ data: { people: PersonRecord[] } }>({
    method: 'GET',
    path: '/people',
    query: {
      filter: `phones.primaryPhoneNumber[eq]:${primaryPhoneNumber}`,
      limit: '1',
    },
  });
  const list = json.data?.people ?? [];
  return list[0] ?? null;
}

export async function findCompanyByName(name: string): Promise<CompanyRecord | null> {
  const json = await twentyFetch<{ data: { companies: CompanyRecord[] } }>({
    method: 'GET',
    path: '/companies',
    query: {
      filter: `name[ilike]:${name}`,
      limit: '1',
    },
  });
  const list = json.data?.companies ?? [];
  return list[0] ?? null;
}

export async function findOpportunityByPersonId(
  personId: string,
): Promise<OpportunityRecord | null> {
  const json = await twentyFetch<{ data: { opportunities: OpportunityRecord[] } }>({
    method: 'GET',
    path: '/opportunities',
    query: {
      filter: `pointOfContactId[eq]:${personId}`,
      limit: '1',
      orderBy: 'createdAt[DescNullsLast]',
    },
  });
  const list = json.data?.opportunities ?? [];
  return list[0] ?? null;
}

// === MUTATIONS — Person ===

export interface CreatePersonInput {
  firstName?: string;
  lastName?: string;
  /** E.164 — e.g. '+5491132766709'. */
  phone: string;
  email?: string;
  companyId?: string | null;
  whatsappUrl?: string;
  firstContactAt?: string;
  lastContactAt?: string;
  messageCount?: number;
}

export async function createPerson(input: CreatePersonInput): Promise<PersonRecord> {
  const body: Record<string, unknown> = {};
  if (input.firstName !== undefined || input.lastName !== undefined) {
    body.name = { firstName: input.firstName ?? '', lastName: input.lastName ?? '' };
  }
  body.phones = parsePhoneE164(input.phone);
  if (input.email) body.emails = { primaryEmail: input.email };
  if (input.companyId) body.companyId = input.companyId;
  if (input.whatsappUrl) body.whatsappUrl = input.whatsappUrl;
  if (input.firstContactAt) body.firstContactAt = input.firstContactAt;
  if (input.lastContactAt) body.lastContactAt = input.lastContactAt;
  if (typeof input.messageCount === 'number') body.messageCount = input.messageCount;

  const json = await twentyFetch<{ data: { createPerson: PersonRecord } }>({
    method: 'POST',
    path: '/people',
    body,
  });
  return json.data.createPerson;
}

export interface UpdatePersonInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  companyId?: string;
  whatsappUrl?: string;
  lastContactAt?: string;
  messageCount?: number;
}

export async function updatePerson(
  personId: string,
  patch: UpdatePersonInput,
): Promise<PersonRecord> {
  const body: Record<string, unknown> = {};
  if (patch.firstName !== undefined || patch.lastName !== undefined) {
    body.name = { firstName: patch.firstName ?? '', lastName: patch.lastName ?? '' };
  }
  if (patch.email) body.emails = { primaryEmail: patch.email };
  if (patch.companyId) body.companyId = patch.companyId;
  if (patch.whatsappUrl) body.whatsappUrl = patch.whatsappUrl;
  if (patch.lastContactAt) body.lastContactAt = patch.lastContactAt;
  if (typeof patch.messageCount === 'number') body.messageCount = patch.messageCount;

  const json = await twentyFetch<{ data: { updatePerson: PersonRecord } }>({
    method: 'PATCH',
    path: `/people/${personId}`,
    body,
  });
  return json.data.updatePerson;
}

// === MUTATIONS — Company ===

export interface CreateCompanyInput {
  name: string;
  /** workspaceMember UUID. When set, becomes the company's accountOwner. */
  accountOwnerId?: string;
}

export async function createCompany(input: CreateCompanyInput): Promise<CompanyRecord> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.accountOwnerId) body.accountOwnerId = input.accountOwnerId;

  const json = await twentyFetch<{ data: { createCompany: CompanyRecord } }>({
    method: 'POST',
    path: '/companies',
    body,
  });
  return json.data.createCompany;
}

// === MUTATIONS — Opportunity ===

export interface CreateOpportunityInput {
  name: string;
  pointOfContactId: string;
  companyId?: string;
  stage?: TwentyStage;
  sourceChannel?: TwentySourceChannel;
  arquetipo?: TwentyArquetipo;
  exception?: TwentyException;
}

export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<OpportunityRecord> {
  const body: Record<string, unknown> = {
    name: input.name,
    pointOfContactId: input.pointOfContactId,
    stage: input.stage ?? 'NEW',
    sourceChannel: input.sourceChannel ?? 'WHATSAPP',
  };
  if (input.companyId) body.companyId = input.companyId;
  if (input.arquetipo) body.arquetipo = input.arquetipo;
  if (input.exception) body.exception = input.exception;

  const json = await twentyFetch<{ data: { createOpportunity: OpportunityRecord } }>({
    method: 'POST',
    path: '/opportunities',
    body,
  });
  return json.data.createOpportunity;
}

export interface UpdateOpportunityInput {
  stage?: TwentyStage;
  arquetipo?: TwentyArquetipo;
  exception?: TwentyException;
  companyId?: string;
}

export async function updateOpportunity(
  opportunityId: string,
  patch: UpdateOpportunityInput,
): Promise<OpportunityRecord> {
  const json = await twentyFetch<{ data: { updateOpportunity: OpportunityRecord } }>({
    method: 'PATCH',
    path: `/opportunities/${opportunityId}`,
    body: patch,
  });
  return json.data.updateOpportunity;
}

// === MUTATIONS — Note ===

/**
 * Creates a Note with markdown body. Returns its id. Use attachNoteToPerson()
 * afterwards to link it (Twenty needs Note + NoteTarget in two calls).
 */
export async function createNote(input: { title: string; body: string }): Promise<{ id: string }> {
  const json = await twentyFetch<{ data: { createNote: { id: string } } }>({
    method: 'POST',
    path: '/notes',
    body: {
      title: input.title,
      bodyV2: { markdown: input.body, blocknote: '' },
    },
  });
  return json.data.createNote;
}

export async function attachNoteToPerson(input: {
  noteId: string;
  personId: string;
}): Promise<void> {
  await twentyFetch({
    method: 'POST',
    path: '/noteTargets',
    body: { noteId: input.noteId, personId: input.personId },
  });
}

// === MUTATIONS — Attachment ===

/** Twenty's fileCategory enum. We emit AUDIO/IMAGE/OTHER from FAMA — others
 *  exist for completeness but FAMA never sets them today. */
export type TwentyFileCategory =
  | 'ARCHIVE'
  | 'AUDIO'
  | 'IMAGE'
  | 'PRESENTATION'
  | 'SPREADSHEET'
  | 'TEXT_DOCUMENT'
  | 'VIDEO'
  | 'OTHER';

export interface CreateAttachmentInput {
  /** Display name shown in Twenty UI (e.g. 'WhatsApp audio - 2026-05-06 14:23'). */
  name: string;
  /** URL the attachment lives at — Chatwoot's data_url for v2. */
  fullPath: string;
  fileCategory: TwentyFileCategory;
  /** At least one target id must be set. We use personId for FAMA. */
  personId?: string;
  opportunityId?: string;
  companyId?: string;
}

/**
 * Creates an Attachment in Twenty and links it to the given target. Twenty
 * stores the URL in `fullPath` — it does NOT host the file itself via REST.
 * For Chatwoot self-hosted attachments the URL requires the viewer to be
 * logged into Chatwoot. See CLAUDE.md "Multimodalidad" for the v3 plan to
 * upload to a real storage if that becomes a problem.
 */
export async function createAttachment(
  input: CreateAttachmentInput,
): Promise<{ id: string }> {
  const json = await twentyFetch<{ data: { createAttachment: { id: string } } }>({
    method: 'POST',
    path: '/attachments',
    body: input,
  });
  return json.data.createAttachment;
}

// === HIGH-LEVEL ===

/**
 * Find a Person by phone, or create a minimal one if missing. Used by the
 * attachment sync path so we always have a target for createAttachment(),
 * even when the agent didn't call upsert-twenty-lead this turn.
 *
 * The minimal Person has firstName='Anónimo', stage NEW (via a sibling
 * Opportunity created by the caller — this helper does NOT create the Opp,
 * since Opp is the agent's job).
 */
export async function findOrCreatePersonByPhone(input: {
  phone: string;
  /** Used as Person.name on creation only — ignored if Person already exists. */
  fallbackFirstName?: string;
  /** Optional WhatsApp conversation URL — set on Person if creating. */
  whatsappUrl?: string;
}): Promise<{ person: PersonRecord; created: boolean }> {
  const existing = await findPersonByPhone(input.phone);
  if (existing) return { person: existing, created: false };
  const created = await createPerson({
    firstName: input.fallbackFirstName ?? 'Anónimo',
    lastName: '',
    phone: input.phone,
    whatsappUrl: input.whatsappUrl,
    firstContactAt: new Date().toISOString(),
    lastContactAt: new Date().toISOString(),
    messageCount: 1,
  });
  return { person: created, created: true };
}

// === HELPERS ===

/**
 * Splits an E.164 phone string into Twenty's three sub-fields. Argentina is
 * the only calling code we parse; everything else falls through with an empty
 * calling code and the trimmed input as the national number — Twenty accepts
 * that and lookups by primaryPhoneNumber still work.
 */
export function parsePhoneE164(phone: string): {
  primaryPhoneCallingCode: string;
  primaryPhoneCountryCode: string;
  primaryPhoneNumber: string;
} {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+54')) {
    return {
      primaryPhoneCallingCode: '+54',
      primaryPhoneCountryCode: 'AR',
      primaryPhoneNumber: trimmed.slice(3),
    };
  }
  // Strip a leading '+' so the national number is consistent regardless of input.
  const stripped = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  return {
    primaryPhoneCallingCode: '',
    primaryPhoneCountryCode: '',
    primaryPhoneNumber: stripped,
  };
}

/**
 * Splits a free-form name into firstName + lastName for Twenty's FULL_NAME
 * field. If only one token, it goes to firstName and lastName is empty.
 */
export function splitName(name: string): { firstName: string; lastName: string } {
  const trimmed = name.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

const STAGE_ORDER: Record<TwentyStage, number> = {
  NEW: 0,
  CONTACTED: 1,
  MEETING: 2,
  PROPOSAL: 3,
  WON: 4,
  LOST: 4,
};

/**
 * Maps Twenty's legacy stage values onto our canonical ones. SCREENING is the
 * old name for CONTACTED; CUSTOMER is the old name for WON. Anything else is
 * returned as-is.
 */
export function aliasStage(s: string | null | undefined): TwentyStage | null {
  if (!s) return null;
  if (s === 'SCREENING') return 'CONTACTED';
  if (s === 'CUSTOMER') return 'WON';
  if ((TWENTY_STAGES as readonly string[]).includes(s)) return s as TwentyStage;
  return null;
}

/**
 * Returns true if `to` is a legal forward move from `from`. Stage only
 * advances; never goes backwards. LOST is always reachable (terminal). WON is
 * also terminal except that LOST may follow (rare, but allowed).
 */
export function canAdvanceStage(
  from: string | null | undefined,
  to: TwentyStage,
): boolean {
  const current = aliasStage(from);
  if (current === null) return true;
  if (to === 'LOST') return true;
  if (current === 'LOST') return false;
  // 'LOST' was already accepted above (terminal). From WON, the only legal
  // remaining target is WON itself (no-op).
  if (current === 'WON') return to === 'WON';
  return STAGE_ORDER[to] >= STAGE_ORDER[current];
}
