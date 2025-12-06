import { Logger } from 'pino';

export async function tryFn(
  fn: () => Promise<void>,
  context: string,
  logger: Logger,
) {
  try {
    await fn();
  } catch (error) {
    logger.error({ context, err: error as Error }, `Error in ${context}`);
  }
}
