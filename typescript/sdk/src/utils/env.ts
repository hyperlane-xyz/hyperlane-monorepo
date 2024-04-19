import z from 'zod';

import { safelyAccessEnvVar } from '@hyperlane-xyz/utils';

const envScheme = z.object({
  HYP_KEY: z.string().optional(),
  ANVIL_IP_ADDR: z.string().optional(),
  ANVIL_PORT: z.number().optional(),
});

const parsedEnv = envScheme.safeParse(safelyAccessEnvVar('env', true));

export const ENV = parsedEnv.success ? parsedEnv.data : {};
