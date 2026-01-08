/**
 * Slack message formatting utilities.
 * Handles formatting Claude output for display in Slack.
 */

// Slack has a ~4000 character limit per message block
const MAX_MESSAGE_LENGTH = 3900;

/**
 * Format a "thinking" message that shows Claude's progress.
 * Truncates from the beginning to show the most recent content.
 */
export function formatThinkingMessage(buffer: string): string {
  if (buffer.length > MAX_MESSAGE_LENGTH) {
    return '...' + buffer.slice(-MAX_MESSAGE_LENGTH);
  }
  return buffer;
}

/**
 * Format a tool call for display.
 */
export function formatToolCall(toolName: string, preview?: string): string {
  const icon = getToolIcon(toolName);
  return preview
    ? `${icon} \`${toolName}\`: ${preview}`
    : `${icon} \`${toolName}\``;
}

/**
 * Get an appropriate icon for a tool.
 */
function getToolIcon(toolName: string): string {
  if (toolName.startsWith('mcp__grafana__')) return '\u{1F4CA}'; // chart
  if (toolName.startsWith('mcp__google-cloud-mcp__')) return '\u{2601}\u{FE0F}'; // cloud
  if (toolName.startsWith('mcp__hyperlane-explorer__')) return '\u{1F50D}'; // magnifying glass
  if (toolName.startsWith('mcp__notion__')) return '\u{1F4DD}'; // memo
  if (toolName === 'Read') return '\u{1F4C4}'; // page
  if (toolName === 'Grep' || toolName === 'Glob') return '\u{1F50E}'; // search
  if (toolName === 'Bash') return '\u{1F4BB}'; // laptop
  if (toolName === 'Edit' || toolName === 'Write') return '\u{270F}\u{FE0F}'; // pencil
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return '\u{1F310}'; // globe
  return '\u{1F527}'; // wrench (default)
}

export interface SlackMessage {
  text: string;
  blocks?: Array<{
    type: string;
    text?: { type: string; text: string };
  }>;
}

/**
 * Format the final result using Slack Block Kit.
 */
export function formatFinalResult(result: string): SlackMessage {
  // Truncate result if too long
  const truncatedResult =
    result.length > MAX_MESSAGE_LENGTH
      ? result.slice(0, MAX_MESSAGE_LENGTH) + '\n\n_(truncated)_'
      : result;

  return {
    text: truncatedResult, // Fallback for notifications
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncatedResult,
        },
      },
    ],
  };
}

/**
 * Format an error message.
 */
export function formatError(error: string): SlackMessage {
  const errorText = `\u{274C} *Error:* ${error}`;
  return {
    text: errorText, // Fallback for notifications
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: errorText,
        },
      },
    ],
  };
}

/**
 * Format a status update (e.g., "Investigation complete").
 */
export function formatStatus(
  status: 'investigating' | 'complete' | 'error',
): string {
  switch (status) {
    case 'investigating':
      return '\u{1F50D} Investigating...';
    case 'complete':
      return '\u{2705} Investigation complete';
    case 'error':
      return '\u{274C} Investigation failed';
  }
}
