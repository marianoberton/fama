import { getContactConversations } from '../../lib/chatwoot.js';
import { detectKnownCustomer, formatKnownCustomerContext } from '../../lib/known-customer.js';
import { logger } from '../../lib/logger.js';

/**
 * Checks whether the incoming contact has prior conversations that qualify
 * them as a "known customer". If so, returns a context string to prepend to
 * the LLM input. Fail-closed: any error returns null so the normal flow
 * continues without crashing.
 */
export async function resolveKnownCustomer(input: {
  contactId: number;
  conversationId: number;
  inboxId: number;
}): Promise<{ knownContext: string | null }> {
  const { contactId, conversationId, inboxId } = input;
  try {
    const conversations = await getContactConversations({ contactId });
    const now = Date.now();
    const signal = detectKnownCustomer({
      conversations,
      now,
      inboxId,
      excludeConversationId: conversationId,
    });
    if (signal.known) {
      const knownContext = formatKnownCustomerContext({ signal, now });
      logger.info(
        {
          conversationId,
          contactId,
          priorCount: signal.count,
          lastConversationAt: signal.lastConversationAt,
        },
        'known-customer: detected — skipping welcome, injecting context to LLM',
      );
      return { knownContext };
    }
    logger.info(
      { conversationId, contactId, scanned: conversations.length },
      'known-customer: not detected — first contact, normal flow',
    );
    return { knownContext: null };
  } catch (err) {
    logger.error(
      { err: (err as Error).message, conversationId, contactId },
      'known-customer: lookup failed — fail-closed, treating as not known',
    );
    return { knownContext: null };
  }
}
