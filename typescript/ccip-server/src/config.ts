import dotenvFlow from 'dotenv-flow';
import { z } from 'zod';

dotenvFlow.config();

// Global configuration schema for the server
const ConfigSchema = z.object({
  ENABLED_MODULES: z
    .string()
    .default('')
    .transform((val) =>
      val
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    ),
});

const config = ConfigSchema.parse(process.env);

export function getEnabledModules(): string[] {
  return config.ENABLED_MODULES;
}
