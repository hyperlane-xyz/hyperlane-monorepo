import type { Server } from 'node:http';

import type { Logger } from 'pino';

import type { CcipApp } from '../http.js';

const SHUTDOWN_GRACE_MS = 10_000;

export async function closeServers(
  app: CcipApp,
  metricsServer: Server,
  logger: Logger,
  graceMs = SHUTDOWN_GRACE_MS,
): Promise<void> {
  const forceTimer = setTimeout(() => {
    logger.warn('Forcing shutdown after timeout');
    app.server.closeAllConnections();
    metricsServer.closeAllConnections();
  }, graceMs);
  forceTimer.unref();

  const metricsClosed = new Promise<void>((resolve, reject) => {
    metricsServer.close((error) => (error ? reject(error) : resolve()));
  });
  try {
    const results = await Promise.allSettled([app.close(), metricsClosed]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  } finally {
    clearTimeout(forceTimer);
  }
}
