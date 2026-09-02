import { z } from 'zod';

import { rootLogger } from '@hyperlane-xyz/utils';

export function isCompliant<S extends z.ZodType>(schema: S) {
  return (config: unknown): config is z.infer<S> => z.validate(schema, config);
}

export function validateZodResult<O>(
  result: z.ZodSafeParseResult<O>,
  desc: string = 'config',
): O {
  if (!result.success) {
    rootLogger.warn(`Invalid ${desc}`, result.error);
    throw new Error(`Invalid desc: ${result.error.toString()}`);
  } else {
    return result.data;
  }
}
