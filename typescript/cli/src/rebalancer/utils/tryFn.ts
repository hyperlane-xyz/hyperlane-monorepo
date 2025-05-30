import { logger } from './logger.js';

export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (error) {
    logger.error(`Error in ${context}`, error);
  }
}
