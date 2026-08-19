import dotenvFlow from 'dotenv-flow';
import { z } from 'zod';

dotenvFlow.config();

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  EVENT_STREAM_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(5_000)
    .default(500),
  LISTEN_DATABASE_URL: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(8383),
});

export const config = ConfigSchema.parse(process.env);
