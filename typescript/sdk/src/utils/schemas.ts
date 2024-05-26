import { z } from 'zod';

export function isCompliant<S extends Zod.Schema>(schema: S) {
  return (config: unknown): config is z.infer<S> =>
    schema.safeParse(config).success;
}
