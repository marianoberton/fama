import {
  processAttachments,
  type ChatwootRawAttachment,
  type ProcessedAttachment,
} from '../../lib/attachment-processor.js';
import {
  isTwentyConfigured,
  findOrCreatePersonByPhone,
  createAttachment,
  type TwentyFileCategory,
} from '../../lib/twenty.js';
import { logger } from '../../lib/logger.js';

export type { ChatwootRawAttachment, ProcessedAttachment };

/**
 * Processes raw Chatwoot attachments (audio → Whisper transcript, image →
 * gpt-4o vision description) and returns enriched content. Falls through with
 * the original content if processing crashes — the conversation never breaks
 * due to media errors.
 */
export async function processMessageAttachments(input: {
  originalContent: string;
  attachments: ChatwootRawAttachment[];
  conversationId: number;
}): Promise<{
  effectiveContent: string;
  processedAttachments: ProcessedAttachment[];
  hasMedia: boolean;
}> {
  if (input.attachments.length === 0) {
    return { effectiveContent: input.originalContent, processedAttachments: [], hasMedia: false };
  }
  try {
    const result = await processAttachments({
      originalContent: input.originalContent,
      attachments: input.attachments,
    });
    logger.info(
      {
        conversationId: input.conversationId,
        attachmentCount: input.attachments.length,
        processedCount: result.processed.length,
        mediaCount: result.processed.filter(
          (p) => p.category === 'AUDIO' || p.category === 'IMAGE',
        ).length,
        hasMedia: result.hasMedia,
        enrichedLen: result.enrichedContent.length,
      },
      'webhook: attachments processed',
    );
    return {
      effectiveContent: result.enrichedContent,
      processedAttachments: result.processed,
      hasMedia: result.hasMedia,
    };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, conversationId: input.conversationId },
      'webhook: attachment processing crashed — falling through with original content',
    );
    return { effectiveContent: input.originalContent, processedAttachments: [], hasMedia: false };
  }
}

/**
 * Sprint 2 D3: stores every supported attachment (AUDIO/IMAGE) in Twenty
 * against the contact's Person. All errors are swallowed — a sync failure
 * must never break the customer conversation.
 */
export async function syncAttachmentsToTwenty(input: {
  processed: ProcessedAttachment[];
  phone: string;
  contactName: string;
  conversationId: number;
  baseUrl: string;
  accountId: number;
}): Promise<void> {
  if (input.processed.length === 0) return;
  if (!input.phone) {
    logger.warn(
      { conversationId: input.conversationId, count: input.processed.length },
      'twenty-attachment-sync: no phone in message — skipping (no Person to attach to)',
    );
    return;
  }
  if (!isTwentyConfigured()) {
    logger.debug(
      { conversationId: input.conversationId, count: input.processed.length },
      'twenty-attachment-sync: Twenty not configured — skipping',
    );
    return;
  }

  const whatsappUrl = `${input.baseUrl}/app/accounts/${input.accountId}/conversations/${input.conversationId}`;
  let personId: string;
  try {
    const fallbackFirstName = input.contactName.trim() || 'Anónimo';
    const result = await findOrCreatePersonByPhone({
      phone: input.phone,
      fallbackFirstName,
      whatsappUrl,
    });
    personId = result.person.id;
    if (result.created) {
      logger.info(
        { phone: input.phone, personId, conversationId: input.conversationId },
        'twenty-attachment-sync: created minimal Person for attachment storage',
      );
    }
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        phone: input.phone,
        conversationId: input.conversationId,
      },
      'twenty-attachment-sync: findOrCreatePerson failed — skipping all attachments this turn',
    );
    return;
  }

  const dateLabel = new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const att of input.processed) {
    if (att.category === 'OTHER') continue;
    const fileCategory: TwentyFileCategory = att.category;
    const name =
      att.category === 'AUDIO'
        ? `WhatsApp audio - ${dateLabel}`
        : `WhatsApp image - ${dateLabel}`;
    try {
      const created = await createAttachment({
        name,
        fullPath: att.dataUrl,
        fileCategory,
        personId,
      });
      logger.info(
        {
          attachmentId: created.id,
          personId,
          chatwootAttachmentId: att.id,
          category: att.category,
          extracted: att.extractedText !== null,
        },
        'twenty-attachment-sync: attachment linked to Person',
      );
    } catch (err) {
      logger.error(
        {
          err: (err as Error).message,
          chatwootAttachmentId: att.id,
          category: att.category,
          personId,
        },
        'twenty-attachment-sync: createAttachment failed (continuing with the rest)',
      );
    }
  }
}
