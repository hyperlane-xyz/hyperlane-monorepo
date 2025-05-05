import { errorRed } from '../../../logger.js';

export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (e) {
    errorRed(`Error in ${context}`, e);
  }
}
