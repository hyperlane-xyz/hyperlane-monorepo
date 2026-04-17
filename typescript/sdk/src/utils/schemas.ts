import { SafeParseReturnType, z } from 'zod';

import { rootLogger } from '@hyperlane-xyz/utils';

export function isCompliant<S extends z.ZodTypeAny>(schema: S) {
  return (config: unknown): config is z.infer<S> =>
    schema.safeParse(config).success;
}

export function validateZodResult<I, O>(
  result: SafeParseReturnType<I, O>,
  desc: string = 'config',
): O {
  if (!result.success) {
    rootLogger.warn(`Invalid ${desc}`, result.error);
    throw new Error(`Invalid desc: ${result.error.toString()}`);
  } else {
    return result.data;
  }
}
