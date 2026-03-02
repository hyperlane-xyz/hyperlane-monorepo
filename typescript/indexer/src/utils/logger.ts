import type { Logger } from 'pino';

import { createServiceLogger, rootLogger } from '@hyperlane-xyz/utils';

let logger: Logger = rootLogger;

/**
 * Initialize the indexer logger.
 * Should be called once at startup before any logging.
 */
export async function initLogger(): Promise<void> {
  const version = process.env.SERVICE_VERSION ?? 'dev';
  logger = await createServiceLogger({
    service: 'hyperlane-indexer',
    version,
    module: 'indexer',
  });
}

/**
 * Get the indexer logger instance.
 * Returns the root logger if initLogger hasn't been called yet.
 */
export function getLogger(): Logger {
  return logger;
}

/**
 * Create a child logger with additional context.
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
