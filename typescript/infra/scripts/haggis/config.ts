import { rootLogger } from '@hyperlane-xyz/utils';

export const logger = rootLogger.child({ module: 'haggis' });

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnvOrDefault(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export const config = {
  slack: {
    botToken: getEnvOrThrow('SLACK_BOT_TOKEN'),
    appToken: getEnvOrThrow('SLACK_APP_TOKEN'),
  },
  claude: {
    maxTurns: parseInt(getEnvOrDefault('CLAUDE_MAX_TURNS', '20'), 10),
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'WebFetch',
      'WebSearch',
      'Skill',
      'mcp__grafana__*',
      'mcp__google-cloud-mcp__*',
      'mcp__hyperlane-explorer__*',
      'mcp__notion__*',
    ],
  },
  // Slack rate limits updates, so we batch them
  messageUpdateInterval: 2500, // ms between Slack message updates
};
