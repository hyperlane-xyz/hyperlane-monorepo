import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x-prefixed address');

const ChainConfigSchema = z.object({
  domain: z.number().int().positive(),
  mailbox: AddressSchema,
  merkleTreeHook: AddressSchema,
  rpcUrls: z.array(z.string().url()).min(1),
  /** Blocks past the dispatch block to wait before trusting the on-chain checkpoint. */
  reorgPeriod: z.number().int().nonnegative().default(0),
});
export type ChainConfig = z.infer<typeof ChainConfigSchema>;

export const AppConfigSchema = z.object({
  chains: z
    .record(z.string(), ChainConfigSchema)
    .refine((m) => Object.keys(m).length > 0, {
      message: 'must define at least one chain',
    }),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, 'utf8');
  return AppConfigSchema.parse(parseYaml(raw));
}

export function getValidatorKey(): string {
  const key = process.env.VALIDATOR_KEY;
  assert(
    key !== undefined && key.length > 0,
    'VALIDATOR_KEY environment variable must be set',
  );
  return key;
}
