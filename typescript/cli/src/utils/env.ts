import { z } from 'zod';

// Custom boolean parser for environment variables
// Environment variables are strings, so "true"/"1" = true, anything else = undefined
const booleanFromString = z
  .string()
  .optional()
  .transform((val) => (val === 'true' || val === '1' ? true : undefined));

const envScheme = z.object({
  HYP_KEY: z.string().optional(),
  ANVIL_IP_ADDR: z.string().optional(),
  ANVIL_PORT: z.coerce.number().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  GH_AUTH_TOKEN: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
  HYP_USE_MULTIPLEX: booleanFromString,
  HYP_MAX_RETRIES: z.coerce.number().optional(),
  HYP_RETRY_DELAY: z.coerce.number().optional(),
  HYP_MAX_RETRY_DELAY: z.coerce.number().optional(),
  HYP_RETRY_BACKOFF: z.coerce.number().optional(),
});

const parsedEnv = envScheme.safeParse(process.env);

export const ENV = parsedEnv.success ? parsedEnv.data : {};
