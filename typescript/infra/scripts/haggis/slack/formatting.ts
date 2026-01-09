/**
 * Slack message formatting utilities.
 * Handles formatting Claude output for display in Slack.
 */

// Slack Block Kit text blocks have a 3000 character limit
const MAX_MESSAGE_LENGTH = 2900;

/**
 * Convert Markdown to Slack mrkdwn format.
 * Slack uses different syntax for formatting.
 */
function markdownToSlack(text: string): string {
  return (
    text
      // Bold: **text** or __text__ → *text*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      // Headers: ## Header → *Header* (Slack has no headers, use bold)
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      // Bullets: - item → • item (but not inside code blocks)
      .replace(/^(\s*)[-*]\s+(?!`)/gm, '$1• ')
      // Links: [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
  );
}

/**
 * Split text into chunks that fit Slack's limit.
 * Avoids splitting inside code blocks or tables.
 */
function splitIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find the best split point within maxLength
    const searchArea = remaining.slice(0, maxLength);

    // Check if we're inside a code block at the cut point
    const codeBlockCount = (searchArea.match(/```/g) || []).length;
    const insideCodeBlock = codeBlockCount % 2 === 1;

    let splitIndex: number;

    if (insideCodeBlock) {
      // Find the start of the code block and split before it
      const lastCodeBlockStart = searchArea.lastIndexOf('```');
      if (lastCodeBlockStart > 0) {
        // Find a good split point before the code block
        const beforeCodeBlock = searchArea.slice(0, lastCodeBlockStart);
        splitIndex = findSplitPoint(beforeCodeBlock);
      } else {
        // Code block started before our search area, find its end
        const endOfCodeBlock = remaining.indexOf('```', 3);
        if (endOfCodeBlock !== -1 && endOfCodeBlock < remaining.length) {
          // Include the entire code block even if it exceeds maxLength
          const afterEnd = remaining.indexOf('\n', endOfCodeBlock + 3);
          splitIndex = afterEnd !== -1 ? afterEnd + 1 : endOfCodeBlock + 3;
        } else {
          splitIndex = findSplitPoint(searchArea);
        }
      }
    } else {
      // Check if we're inside a table (lines starting with |)
      const lines = searchArea.split('\n');
      const lastLineIndex = lines.length - 1;
      const insideTable =
        lastLineIndex > 0 && lines[lastLineIndex].trim().startsWith('|');

      if (insideTable) {
        // Find the end of the table
        const tableEndMatch = searchArea.match(/\n(?!\s*\|)/g);
        if (tableEndMatch) {
          const tableEnd = searchArea.lastIndexOf('\n\n');
          if (tableEnd > 0) {
            splitIndex = tableEnd + 2;
          } else {
            splitIndex = findSplitPoint(searchArea);
          }
        } else {
          splitIndex = findSplitPoint(searchArea);
        }
      } else {
        splitIndex = findSplitPoint(searchArea);
      }
    }

    // Ensure we make progress
    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Find the best split point in the text.
 * Prefers paragraph breaks, then line breaks.
 */
function findSplitPoint(text: string): number {
  // Prefer splitting at paragraph breaks (double newline)
  const paragraphBreak = text.lastIndexOf('\n\n');
  if (paragraphBreak > text.length * 0.3) {
    return paragraphBreak + 2;
  }

  // Fall back to line breaks
  const lineBreak = text.lastIndexOf('\n');
  if (lineBreak > text.length * 0.3) {
    return lineBreak + 1;
  }

  // Last resort: split at a space
  const space = text.lastIndexOf(' ');
  if (space > text.length * 0.3) {
    return space + 1;
  }

  // No good split point found
  return text.length;
}

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
 * Format the final result as multiple Slack messages.
 * Converts Markdown to Slack mrkdwn and splits into chunks.
 */
export function formatFinalResults(result: string): SlackMessage[] {
  const formatted = markdownToSlack(result);
  const chunks = splitIntoChunks(formatted, MAX_MESSAGE_LENGTH);

  return chunks.map((chunk) => ({
    text: chunk, // Fallback for notifications
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: chunk,
        },
      },
    ],
  }));
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
