/**
 * PagerDuty context extraction from Slack messages.
 * Extracts incident information from thread messages to provide context to Claude.
 */

export interface PagerDutyContext {
  incidentUrl?: string;
  incidentId?: string;
  alertTitle?: string;
}

// Regex patterns for extracting PagerDuty info
const PD_URL_REGEX = /https:\/\/[^\/]*pagerduty\.com\/incidents\/([A-Z0-9]+)/gi;
const PD_ALERT_TITLE_REGEX = /\*?Alert:?\*?\s*(.+?)(?:\n|$)/i;

/**
 * Extract PagerDuty context from Slack messages in a thread.
 * Looks for PagerDuty incident URLs and alert titles.
 */
export function extractPagerDutyContext(
  messages: Array<{ text?: string; attachments?: Array<{ text?: string }> }>,
): PagerDutyContext {
  const context: PagerDutyContext = {};

  for (const msg of messages) {
    // Check main message text
    const text = msg.text || '';
    extractFromText(text, context);

    // Check attachments (PagerDuty often uses unfurled links)
    if (msg.attachments) {
      for (const attachment of msg.attachments) {
        if (attachment.text) {
          extractFromText(attachment.text, context);
        }
      }
    }

    // Stop if we found what we need
    if (context.incidentUrl) {
      break;
    }
  }

  return context;
}

function extractFromText(text: string, context: PagerDutyContext): void {
  // Extract PagerDuty URL
  const urlMatch = PD_URL_REGEX.exec(text);
  if (urlMatch) {
    context.incidentUrl = urlMatch[0];
    context.incidentId = urlMatch[1];
  }
  // Reset regex lastIndex for next use
  PD_URL_REGEX.lastIndex = 0;

  // Extract alert title if present
  if (!context.alertTitle) {
    const titleMatch = text.match(PD_ALERT_TITLE_REGEX);
    if (titleMatch) {
      context.alertTitle = titleMatch[1].trim();
    }
  }
}

/**
 * Build a context prompt from extracted PagerDuty information.
 * This prompt is prepended to the user's message to give Claude context.
 */
export function buildContextPrompt(context: PagerDutyContext): string {
  const parts: string[] = [];

  if (context.incidentUrl) {
    parts.push(`**PagerDuty Incident:** ${context.incidentUrl}`);
  }

  if (context.alertTitle) {
    parts.push(`**Alert:** ${context.alertTitle}`);
  }

  if (parts.length === 0) {
    return '';
  }

  return `## Context from Thread

${parts.join('\n')}

Please investigate this incident using the available tools (Grafana, GCP logs, Hyperlane Explorer).
Focus on identifying the root cause and suggesting remediation steps.

---

`;
}

/**
 * Extract Grafana alert context from Slack messages.
 * Grafana alerts often come with different formatting than PagerDuty.
 */
export function extractGrafanaContext(
  messages: Array<{ text?: string; attachments?: Array<{ text?: string }> }>,
): { alertName?: string; labels?: Record<string, string> } {
  const context: { alertName?: string; labels?: Record<string, string> } = {};

  for (const msg of messages) {
    const text = msg.text || '';

    // Grafana alert format: [FIRING:1] Alert Name
    const alertMatch = text.match(
      /\[(?:FIRING|RESOLVED):\d+\]\s*(.+?)(?:\n|$)/,
    );
    if (alertMatch) {
      context.alertName = alertMatch[1].trim();
    }

    // Extract labels (key=value format)
    const labelMatches = text.matchAll(/(\w+)=["']?([^"'\s,]+)["']?/g);
    for (const match of labelMatches) {
      if (!context.labels) context.labels = {};
      context.labels[match[1]] = match[2];
    }
  }

  return context;
}
