import { z } from 'zod';

// Should be used instead of referencing process directly in case we don't
// run in node.js
export function safelyAccessEnvVar(name: string, toLowerCase = false) {
  try {
    return toLowerCase ? process.env[name]?.toLowerCase() : process.env[name];
  } catch {
    return undefined;
  }
}

export function inCIMode() {
  return process.env.CI === 'true';
}

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

export const CLI_ENV = parsedEnv.success ? parsedEnv.data : {};
