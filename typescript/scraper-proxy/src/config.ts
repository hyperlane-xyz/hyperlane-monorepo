import dotenvFlow from 'dotenv-flow';
import { z } from 'zod';

dotenvFlow.config();

const ConfigSchema = z.object({
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(20_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15_000),
  DATABASE_URL: z.string().min(1),
  EVENT_STREAM_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(5_000)
    .default(500),
  EVENT_STREAM_HISTORY_MAX_CONCURRENT: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2),
  EVENT_STREAM_HISTORY_MAX_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(1_800_000),
  EVENT_STREAM_HISTORY_MAX_ROWS: z.coerce
    .number()
    .int()
    .min(1)
    .default(1_000_000),
  EVENT_STREAM_MAX_BUFFERED_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(1_048_576),
  EVENT_STREAM_MAX_TOTAL_BUFFERED_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(33_554_432),
  GRAPHQL_MAX_ACTIVE_REQUESTS: z.coerce.number().int().min(1).default(25),
  PORT: z.coerce.number().int().positive().default(8383),
});

export const config = ConfigSchema.parse(process.env);
