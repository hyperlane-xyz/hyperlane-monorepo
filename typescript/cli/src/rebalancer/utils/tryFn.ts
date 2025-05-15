import { logger } from './logger.js';

export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (e) {
    logger.error(`Error in ${context}`, e);
  }
}
