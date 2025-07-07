import { monitorLogger } from './loggerUtils.js';

export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (error) {
    monitorLogger.error(
      { context, err: error as Error },
      `Error in ${context}`,
    );
  }
}
