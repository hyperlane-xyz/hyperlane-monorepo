/**
 * Haggis - Slack Bot Interface for Claude Code
 *
 * A long-running server that allows users to interact with Claude Code
 * by mentioning @haggis in Slack threads. Streams Claude's chain of thought
 * back to Slack in real-time and maintains session continuity within threads.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... pnpm haggis
 *
 * Environment Variables:
 *   SLACK_BOT_TOKEN  - Bot User OAuth Token (xoxb-...)
 *   SLACK_APP_TOKEN  - App-Level Token for Socket Mode (xapp-...)
 *   ANTHROPIC_API_KEY - Claude API key (optional if already authenticated)
 *   CLAUDE_MAX_TURNS - Max turns per query (default: 20)
 */
import { App, LogLevel } from '@slack/bolt';

import { config, logger } from './config.js';
import { registerEventHandlers } from './slack/events.js';

async function main(): Promise<void> {
  logger.info('Starting Haggis server...');

  // Create Slack app with Socket Mode
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
    // Custom logger to integrate with our pino logger
    logger: {
      debug: (...msgs) => logger.debug(msgs.join(' ')),
      info: (...msgs) => logger.info(msgs.join(' ')),
      warn: (...msgs) => logger.warn(msgs.join(' ')),
      error: (...msgs) => logger.error(msgs.join(' ')),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName: () => {},
    },
  });

  // Register event handlers
  registerEventHandlers(app);

  // Start the app
  await app.start();
  logger.info('Haggis is running! Listening for @mentions...');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal');
    try {
      await app.stop();
      logger.info('Haggis stopped gracefully');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run the server
main().catch((error) => {
  logger.error({ error }, 'Failed to start Haggis');
  process.exit(1);
});
