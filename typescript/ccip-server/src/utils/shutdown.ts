import type { Server } from 'node:http';

import type { Logger } from 'pino';

import { assert } from '@hyperlane-xyz/utils';

import type { CcipApp } from '../http.js';

const SHUTDOWN_GRACE_MS = 10_000;
const HARD_SHUTDOWN_MS = 20_000;

export type CloseServersOptions = {
  forceExit?: (code: number) => void;
  graceMs?: number;
  hardMs?: number;
};

export async function closeServers(
  app: CcipApp,
  metricsServer: Server,
  logger: Logger,
  options: CloseServersOptions = {},
): Promise<void> {
  const {
    forceExit = (code) => process.exit(code),
    graceMs = SHUTDOWN_GRACE_MS,
    hardMs = HARD_SHUTDOWN_MS,
  } = options;
  assert(hardMs > graceMs, 'Hard shutdown must follow connection cleanup');
  const forceTimer = setTimeout(() => {
    logger.warn('Forcing shutdown after timeout');
    app.server.closeAllConnections();
    metricsServer.closeAllConnections();
  }, graceMs);
  forceTimer.unref();
  const hardTimer = setTimeout(() => {
    logger.error('Hard shutdown deadline exceeded');
    forceExit(1);
  }, hardMs);
  hardTimer.unref();

  const metricsClosed = new Promise<void>((resolve, reject) => {
    metricsServer.close((error) => (error ? reject(error) : resolve()));
  });
  try {
    const results = await Promise.allSettled([app.close(), metricsClosed]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } finally {
    clearTimeout(forceTimer);
    clearTimeout(hardTimer);
  }
}
