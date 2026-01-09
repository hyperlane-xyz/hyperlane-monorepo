/**
 * Slack event handlers for Haggis.
 * Handles app_mention events to trigger Claude Code investigations.
 */
import type { App } from '@slack/bolt';

import { executeClaudeQuery } from '../claude/executor.js';
import { config, logger } from '../config.js';

import {
  formatError,
  formatFinalResult,
  formatStatus,
  formatThinkingMessage,
  formatToolCall,
} from './formatting.js';

// Event type for app_mention
interface AppMentionEvent {
  text: string;
  thread_ts?: string;
  ts: string;
  channel: string;
  user: string;
}

/**
 * Register all Slack event handlers on the app.
 */
export function registerEventHandlers(app: App): void {
  // Handle @haggis mentions
  app.event('app_mention', async ({ event, client, say }) => {
    const mentionEvent = event as AppMentionEvent;

    const threadTs = mentionEvent.thread_ts || mentionEvent.ts;
    // Remove the @mention from the message to get the actual query
    const userMessage = mentionEvent.text.replace(/<@[^>]+>/g, '').trim();

    logger.info(
      { threadTs, channel: mentionEvent.channel, userMessage },
      'Received app mention',
    );

    // Don't respond to empty messages
    if (!userMessage) {
      await say({
        thread_ts: threadTs,
        text: "Hi! I'm Haggis. Mention me with a question or task, like `@haggis debug this issue`.",
      });
      return;
    }

    // Post initial "investigating" message
    const thinkingMsg = await say({
      thread_ts: threadTs,
      text: formatStatus('investigating'),
    });

    if (!thinkingMsg.ts) {
      logger.error('Failed to post thinking message');
      return;
    }

    // Stream Claude's response
    let buffer = '';
    let lastUpdate = Date.now();
    let hasResult = false;

    try {
      for await (const msg of executeClaudeQuery(threadTs, userMessage)) {
        if (msg.type === 'thinking') {
          buffer += msg.content + '\n';
        } else if (msg.type === 'tool_call') {
          buffer += formatToolCall(msg.content) + '\n';
        }

        // Batch updates to avoid rate limits
        const now = Date.now();
        if (now - lastUpdate > config.messageUpdateInterval && buffer) {
          try {
            await client.chat.update({
              channel: mentionEvent.channel,
              ts: thinkingMsg.ts,
              text: formatThinkingMessage(buffer),
            });
            lastUpdate = now;
          } catch (updateError) {
            // Rate limit or other error - just continue
            logger.debug({ error: updateError }, 'Failed to update message');
          }
        }

        if (msg.type === 'result') {
          hasResult = true;

          // Post final result as new message
          await say({
            thread_ts: threadTs,
            ...formatFinalResult(msg.content),
          });

          // Update thinking message to show completion
          await client.chat.update({
            channel: mentionEvent.channel,
            ts: thinkingMsg.ts,
            text: formatStatus('complete'),
          });
        }

        if (msg.type === 'error') {
          await say({
            thread_ts: threadTs,
            ...formatError(msg.content),
          });

          await client.chat.update({
            channel: mentionEvent.channel,
            ts: thinkingMsg.ts,
            text: formatStatus('error'),
          });
        }
      }

      // If we never got a result, update the thinking message with what we have
      if (!hasResult && buffer) {
        await client.chat.update({
          channel: mentionEvent.channel,
          ts: thinkingMsg.ts,
          text:
            formatThinkingMessage(buffer) +
            '\n\n_(Claude stopped unexpectedly)_',
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, threadTs }, 'Error during Claude execution');

      await client.chat.update({
        channel: mentionEvent.channel,
        ts: thinkingMsg.ts,
        text: formatStatus('error'),
      });

      await say({
        thread_ts: threadTs,
        ...formatError(errorMessage),
      });
    }
  });

  // Log when the app starts receiving events
  app.event('message', async ({ event }) => {
    // Just for debugging - log all messages
    logger.debug({ event: event.type }, 'Received message event');
  });
}
