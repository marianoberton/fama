import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { loadEnv } from '../../config/env.js';
import {
  isTwentyConfigured,
  requireTwentyConfig,
  findPersonByPhone,
  createPerson,
  updatePerson,
  findCompanyByName,
  createCompany,
  findOpportunityByPersonId,
  createOpportunity,
  updateOpportunity,
  createNote,
  attachNoteToPerson,
  splitName,
  canAdvanceStage,
  TwentyApiError,
  type TwentyArquetipo,
  type TwentyException,
  type TwentySourceChannel,
} from '../../lib/twenty.js';

export const TWENTY_LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'MEETING',
  'PROPOSAL',
  'WON',
  'LOST',
] as const;

export const TWENTY_LEAD_SOURCES = ['whatsapp', 'web', 'telegram', 'otro'] as const;

const ARQUETIPOS = ['caliente', 'a-explorar', 'sin-claridad', 'no-lead'] as const;
const EXCEPTIONS = [
  'pedido-humano',
  'consultoria',
  'urgencia',
  'reclamo',
  'demo',
] as const;

export const upsertTwentyLeadInput = z.object({
  name: z
    .string()
    .optional()
    .describe('Nombre del contacto si lo declaró. Si no, dejar vacío y se crea como "Anónimo".'),
  email: z.string().email().optional(),
  company: z.string().optional().describe('Nombre de la empresa si la mencionó.'),
  stage: z
    .enum(TWENTY_LEAD_STAGES)
    .describe(
      'Estado del lead en el embudo. NEW = recién entró sin discovery; CONTACTED = lead a explorar; MEETING = caliente o pidió demo; PROPOSAL = ya hablaron de propuesta; WON/LOST = cerrado.',
    ),
  source: z
    .enum(TWENTY_LEAD_SOURCES)
    .default('whatsapp')
    .describe('Canal por el que llegó el lead.'),
  notes: z
    .string()
    .optional()
    .describe(
      'Notas estructuradas (mismo formato que la nota privada del handoff). Si está presente, se crea una Note adjunta al Person en Twenty.',
    ),
  arquetipo: z
    .enum(ARQUETIPOS)
    .optional()
    .describe(
      'Clasificación del backoffice. caliente=Arq.1, a-explorar=Arq.2, sin-claridad=Arq.3, no-lead=Arq.4.',
    ),
  exception: z
    .enum(EXCEPTIONS)
    .optional()
    .describe(
      'Excepción rígida que disparó el handoff (cuando aplica). null/omit si fue clasificación normal.',
    ),
});

export const upsertTwentyLeadOutput = z.object({
  success: z.boolean(),
  leadId: z.string(),
  personId: z.string().optional(),
  opportunityId: z.string().optional(),
  noteId: z.string().optional(),
  skipped: z.boolean().optional(),
  error: z.string().optional(),
});

const ARQUETIPO_MAP: Record<(typeof ARQUETIPOS)[number], TwentyArquetipo> = {
  caliente: 'CALIENTE',
  'a-explorar': 'A_EXPLORAR',
  'sin-claridad': 'SIN_CLARIDAD',
  'no-lead': 'NO_LEAD',
};

const EXCEPTION_MAP: Record<(typeof EXCEPTIONS)[number], TwentyException> = {
  'pedido-humano': 'PEDIDO_HUMANO',
  consultoria: 'CONSULTORIA',
  urgencia: 'URGENCIA',
  reclamo: 'RECLAMO',
  demo: 'DEMO',
};

const SOURCE_MAP: Record<(typeof TWENTY_LEAD_SOURCES)[number], TwentySourceChannel> = {
  whatsapp: 'WHATSAPP',
  web: 'WEBSITE',
  telegram: 'OTHER',
  otro: 'OTHER',
};

export interface UpsertContext {
  phone: string;
  conversationId: number;
}

/**
 * Pure(-ish) executor — exported for tests with mocked twenty.ts. The createTool
 * wrapper just pulls phone/conversationId from RequestContext and calls this.
 *
 * Accepts the raw (pre-default) input shape and runs Zod parse internally so
 * the source default is applied uniformly whether the call comes from the
 * Mastra runtime, the nurturing worker, or a test.
 */
export async function runUpsertTwentyLead(
  rawInput: z.input<typeof upsertTwentyLeadInput>,
  ctx: UpsertContext,
): Promise<z.infer<typeof upsertTwentyLeadOutput>> {
  const input = upsertTwentyLeadInput.parse(rawInput);
  if (!isTwentyConfigured()) {
    logger.warn(
      { phone: ctx.phone, stage: input.stage },
      'upsert-twenty-lead: TWENTY not configured — skipping (success=true, skipped=true)',
    );
    return {
      success: true,
      leadId: `noop-${Date.now()}`,
      skipped: true,
    };
  }

  const config = requireTwentyConfig();
  const env = loadEnv();
  const now = new Date().toISOString();
  const whatsappUrl = `${env.CHATWOOT_BASE_URL}/app/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${ctx.conversationId}`;

  try {
    let person = await findPersonByPhone(ctx.phone);
    let personCreated = false;

    let companyId: string | undefined;
    if (input.company && input.company.trim()) {
      const existing = await findCompanyByName(input.company.trim());
      if (existing) {
        companyId = existing.id;
      } else {
        const created = await createCompany({
          name: input.company.trim(),
          accountOwnerId: config.ownerUserId || undefined,
        });
        companyId = created.id;
      }
    }

    if (!person) {
      const split = input.name?.trim()
        ? splitName(input.name)
        : { firstName: 'Anónimo', lastName: '' };
      person = await createPerson({
        firstName: split.firstName,
        lastName: split.lastName,
        phone: ctx.phone,
        email: input.email,
        companyId: companyId ?? null,
        whatsappUrl,
        firstContactAt: now,
        lastContactAt: now,
        messageCount: 1,
      });
      personCreated = true;
    } else {
      const patch: Parameters<typeof updatePerson>[1] = {};
      if (input.name && !(person.name?.firstName || person.name?.lastName)) {
        const split = splitName(input.name);
        patch.firstName = split.firstName;
        patch.lastName = split.lastName;
      }
      if (input.email && !person.emails?.primaryEmail) {
        patch.email = input.email;
      }
      if (companyId && !person.companyId) {
        patch.companyId = companyId;
      }
      if (whatsappUrl && !person.whatsappUrl) {
        patch.whatsappUrl = whatsappUrl;
      }
      // Always-update fields per design §4.3.
      patch.lastContactAt = now;
      patch.messageCount = (person.messageCount ?? 0) + 1;

      person = await updatePerson(person.id, patch);
    }

    let opp = await findOpportunityByPersonId(person.id);
    const arquetipo = input.arquetipo ? ARQUETIPO_MAP[input.arquetipo] : undefined;
    const exception = input.exception ? EXCEPTION_MAP[input.exception] : undefined;
    const sourceChannel = SOURCE_MAP[input.source];
    const personDisplayName =
      [person.name?.firstName, person.name?.lastName].filter(Boolean).join(' ').trim() ||
      ctx.phone;
    const oppName = `Lead - ${personDisplayName} - ${now.slice(0, 10)}`;

    if (!opp) {
      opp = await createOpportunity({
        name: oppName,
        pointOfContactId: person.id,
        ...(companyId !== undefined ? { companyId } : {}),
        stage: input.stage,
        sourceChannel,
        ...(arquetipo !== undefined ? { arquetipo } : {}),
        ...(exception !== undefined ? { exception } : {}),
      });
    } else {
      const patch: Parameters<typeof updateOpportunity>[1] = {};
      if (canAdvanceStage(opp.stage, input.stage)) {
        patch.stage = input.stage;
      }
      if (arquetipo && !opp.arquetipo) patch.arquetipo = arquetipo;
      if (exception && !opp.exception) patch.exception = exception;
      if (companyId && !opp.companyId) patch.companyId = companyId;
      if (Object.keys(patch).length > 0) {
        opp = await updateOpportunity(opp.id, patch);
      }
    }

    let noteId: string | undefined;
    if (input.notes && input.notes.trim()) {
      try {
        const noteTitle = `Conversación FOMO - ${now.slice(0, 10)}`;
        const note = await createNote({ title: noteTitle, body: input.notes });
        await attachNoteToPerson({ noteId: note.id, personId: person.id });
        noteId = note.id;
      } catch (err) {
        // Note failure is non-fatal — the lead is already recorded.
        logger.error(
          { err: (err as Error).message, personId: person.id },
          'upsert-twenty-lead: note creation failed (lead still recorded)',
        );
      }
    }

    logger.info(
      {
        personCreated,
        personId: person.id,
        opportunityId: opp.id,
        companyId: companyId ?? null,
        stage: input.stage,
        arquetipo: input.arquetipo,
        exception: input.exception,
        noteId,
        phone: ctx.phone,
      },
      'upsert-twenty-lead: success',
    );

    return {
      success: true,
      leadId: opp.id,
      personId: person.id,
      opportunityId: opp.id,
      ...(noteId !== undefined ? { noteId } : {}),
    };
  } catch (err) {
    const isApiErr = err instanceof TwentyApiError;
    logger.error(
      {
        err: (err as Error).message,
        status: isApiErr ? err.status : undefined,
        phone: ctx.phone,
        stage: input.stage,
      },
      'upsert-twenty-lead: failed',
    );
    return {
      success: false,
      leadId: '',
      error: (err as Error).message.slice(0, 300),
    };
  }
}

export const upsertTwentyLead = createTool({
  id: 'upsert-twenty-lead',
  description:
    'Registra o actualiza un lead en el CRM (Twenty). Crea o actualiza Person + Company + Opportunity identificando por phone, mantiene last_contact_at y message_count, y si pasás `notes` deja una Note adjunta al Person. Stage es enum: NEW | CONTACTED | MEETING | PROPOSAL | WON | LOST. El stage solo avanza, nunca retrocede. El phone se inyecta automáticamente desde el contexto del webhook — no lo incluyas en los argumentos.',
  inputSchema: upsertTwentyLeadInput,
  outputSchema: upsertTwentyLeadOutput,
  // phone + conversationId come from RequestContext (set by webhook handler),
  // not from the LLM. This prevents hallucinated IDs from Studio chats.
  execute: async (input, context) => {
    const phone = context?.requestContext?.get('phone');
    const conversationId = context?.requestContext?.get('conversationId');
    if (typeof phone !== 'string' || !phone) {
      logger.error('upsert-twenty-lead: phone missing from requestContext');
      return { success: false, leadId: '', error: 'missing_phone_in_request_context' };
    }
    if (typeof conversationId !== 'number') {
      logger.error('upsert-twenty-lead: conversationId missing from requestContext');
      return {
        success: false,
        leadId: '',
        error: 'missing_conversation_id_in_request_context',
      };
    }
    return runUpsertTwentyLead(input, { phone, conversationId });
  },
});
