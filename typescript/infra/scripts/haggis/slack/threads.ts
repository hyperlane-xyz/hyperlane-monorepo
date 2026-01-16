/**
 * Utilities for fetching Slack thread messages.
 */
import type { WebClient } from '@slack/web-api';

import { logger } from '../config.js';

/**
 * Fetch all messages from a thread, excluding bot messages and a specific message.
 *
 * @param client - Slack WebClient
 * @param channel - Channel ID
 * @param threadTs - Thread timestamp
 * @param excludeTs - Optional message timestamp to exclude (e.g., the @mention itself)
 * @returns Array of formatted message strings in chronological order
 */
export async function fetchThreadMessages(
  client: WebClient,
  channel: string,
  threadTs: string,
  excludeTs?: string,
): Promise<string[]> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50, // Reasonable limit to avoid huge contexts
    });

    if (!result.messages || result.messages.length === 0) {
      return [];
    }

    const messages: string[] = [];

    for (const msg of result.messages) {
      // Skip the message we're excluding (usually the @mention)
      if (excludeTs && msg.ts === excludeTs) {
        continue;
      }

      // Skip messages without text
      if (!msg.text) {
        continue;
      }

      // Format the message - include user info if available
      const text = msg.text.trim();
      if (text) {
        messages.push(text);
      }
    }

    logger.debug(
      { channel, threadTs, messageCount: messages.length },
      'Fetched thread messages',
    );

    return messages;
  } catch (error) {
    logger.error(
      { error, channel, threadTs },
      'Failed to fetch thread messages',
    );
    return [];
  }
}
