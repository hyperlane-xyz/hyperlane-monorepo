import pino, { LoggerOptions } from 'pino';

import { rootLogger, setRootLogger } from '@hyperlane-xyz/utils';

async function createLogger() {
  // Check if we're running in Kubernetes
  const isKubernetes = process.env.KUBERNETES_SERVICE_HOST !== undefined;

  if (isKubernetes) {
    // Dynamically import GCP logging configuration
    const { createGcpLoggingPinoConfig } = await import(
      '@google-cloud/pino-logging-gcp-config'
    );
    const gcpConfig = createGcpLoggingPinoConfig(
      {
        serviceContext: {
          service: 'warp-balance-monitor',
          version: '1.0.0',
        },
      },
      {
        base: undefined,
        name: 'hyperlane',
      },
    ) as LoggerOptions<never>;
    return pino.pino(gcpConfig);
  }

  // Default logging configuration for non-Kubernetes environments
  return rootLogger.child({ module: 'warp-balance-monitor' });
}

// Initialize logger and set it as root
const logger = await createLogger();
setRootLogger(logger);

export function setLoggerBindings(bindings: Record<string, string>) {
  logger.setBindings(bindings);
}

export { logger };

export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (err) {
    logger.error(err, `Error in ${context}`);
  }
}
