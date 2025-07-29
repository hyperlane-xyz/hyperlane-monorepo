import { z } from 'zod';

const envScheme = z.object({
  HYP_KEY: z.string().optional(),
  ANVIL_IP_ADDR: z.string().optional(),
  ANVIL_PORT: z.number().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  GH_AUTH_TOKEN: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
});

const parsedEnv = envScheme.safeParse(process.env);

export const ENV = parsedEnv.success ? parsedEnv.data : {};
