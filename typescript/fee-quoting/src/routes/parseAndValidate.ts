import { z } from 'zod';

import { ApiError } from '../middleware/errorHandler.js';

/**
 * Parse Express request query params with a Zod schema. Throws `ApiError(400)`
 * with a flattened issue summary on failure; returns the parsed (transformed)
 * data on success. Generic over the schema type so `.transform()` schemas
 * (where input ≠ output) work as expected. Shared across v1 and v2 route
 * handlers.
 */
export function parseAndValidate<S extends z.ZodTypeAny>(
  schema: S,
  query: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    const messages = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ApiError(messages, 400);
  }
  return parsed.data;
}
