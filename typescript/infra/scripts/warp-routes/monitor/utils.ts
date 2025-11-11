import { createServiceLogger, setRootLogger } from '@hyperlane-xyz/utils';

const logger = await createServiceLogger({
  service: 'warp-balance-monitor',
  version: '1.0.0',
});

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
