import { SafeParseReturnType, z } from 'zod';

import { rootLogger } from '@hyperlane-xyz/utils';

export function isCompliant<S extends Zod.Schema>(schema: S) {
  return (config: unknown): config is z.infer<S> =>
    schema.safeParse(config).success;
}

export function validateZodResult<T>(
  result: SafeParseReturnType<T, T>,
  desc: string = 'config',
): T {
  if (!result.success) {
    rootLogger.warn(`Invalid ${desc}`, result.error);
    throw new Error(`Invalid desc: ${result.error.toString()}`);
  } else {
    return result.data;
  }
}
