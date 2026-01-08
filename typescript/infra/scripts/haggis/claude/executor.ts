/**
 * Claude Code executor using the Agent SDK.
 * Wraps the SDK's query function to provide a simpler interface for Haggis.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

import { config, logger } from '../config.js';

import { getSession, setSession } from './sessions.js';

export interface ClaudeMessage {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'result' | 'error';
  content: string;
}

/**
 * Execute a Claude Code query and yield messages as they stream in.
 *
 * @param threadTs - Slack thread timestamp (used for session management)
 * @param prompt - User's prompt/question
 * @param contextPrompt - Optional context to prepend (e.g., PagerDuty incident info)
 */
export async function* executeClaudeQuery(
  threadTs: string,
  prompt: string,
  contextPrompt?: string,
): AsyncGenerator<ClaudeMessage> {
  const sessionId = getSession(threadTs);
  const fullPrompt = contextPrompt ? `${contextPrompt}\n\n${prompt}` : prompt;

  logger.info(
    { threadTs, hasSession: !!sessionId, promptLength: fullPrompt.length },
    'Starting Claude query',
  );

  try {
    for await (const message of query({
      prompt: fullPrompt,
      options: {
        cwd: '/Users/trevor/abacus-monorepo',
        resume: sessionId,
        allowedTools: config.claude.allowedTools,
        maxTurns: config.claude.maxTurns,
        permissionMode: 'bypassPermissions',
      },
    })) {
      // Capture session ID on init
      if (message.type === 'system' && message.subtype === 'init') {
        const newSessionId = (message as any).session_id;
        if (newSessionId) {
          setSession(threadTs, newSessionId);
          logger.info({ threadTs, sessionId: newSessionId }, 'Session created');
        }
      }

      // Handle assistant messages (thinking, tool calls)
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block && block.text) {
            yield { type: 'thinking', content: block.text };
          } else if ('name' in block) {
            const toolName = (block as any).name;
            const toolInput = (block as any).input;
            const inputPreview = toolInput
              ? JSON.stringify(toolInput).slice(0, 100)
              : '';
            yield {
              type: 'tool_call',
              content: `${toolName}${inputPreview ? `: ${inputPreview}...` : ''}`,
            };
          }
        }
      }

      // Handle tool results
      if (message.type === 'user' && message.message?.content) {
        for (const block of message.message.content) {
          if ('content' in block && typeof block.content === 'string') {
            // Tool results can be very long, truncate for display
            const preview = block.content.slice(0, 200);
            yield {
              type: 'tool_result',
              content: preview + (block.content.length > 200 ? '...' : ''),
            };
          }
        }
      }

      // Handle final result
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          const result = (message as any).result || 'Task completed';
          const cost = (message as any).total_cost_usd;
          const costStr = cost ? ` (cost: $${cost.toFixed(4)})` : '';
          yield { type: 'result', content: result + costStr };
        } else {
          // Error or other result type
          yield {
            type: 'error',
            content: `Query ended with status: ${message.subtype}`,
          };
        }
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, threadTs }, 'Claude query failed');
    yield { type: 'error', content: errorMessage };
  }
}
