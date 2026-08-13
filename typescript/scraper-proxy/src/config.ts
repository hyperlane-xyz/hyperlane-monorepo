import dotenvFlow from 'dotenv-flow';
import { z } from 'zod';

dotenvFlow.config();

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LISTEN_DATABASE_URL: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(8383),
});

export const config = ConfigSchema.parse(process.env);
