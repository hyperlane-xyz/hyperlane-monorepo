import { z } from 'zod';

import { TokenFeeConfigInputSchema, ZHash } from '@hyperlane-xyz/sdk';

// ====== CHAIN CONFIG ======

export const TransferRouterChainConfigSchema = z.object({
  token: ZHash,
  owner: ZHash,
  fee: TokenFeeConfigInputSchema.optional(),
});

export type TransferRouterChainConfig = z.infer<
  typeof TransferRouterChainConfigSchema
>;

// ====== DEPLOY CONFIG ======

export const TransferRouterDeployConfigSchema = z
  .record(TransferRouterChainConfigSchema)
  .refine(
    (config) => Object.keys(config).length > 0,
    'At least one chain configuration is required',
  );

export type TransferRouterDeployConfig = z.infer<
  typeof TransferRouterDeployConfigSchema
>;

// ====== DEPLOYMENT ======

export const TransferRouterDeploymentSchema = z.object({
  transferRouter: ZHash,
  token: ZHash,
  feeContract: ZHash,
  owner: ZHash,
});

export type TransferRouterDeployment = z.infer<
  typeof TransferRouterDeploymentSchema
>;

// ====== OUTPUT ======

export const TransferRouterOutputSchema = z.record(
  TransferRouterDeploymentSchema,
);

export type TransferRouterOutput = z.infer<typeof TransferRouterOutputSchema>;

// ====== PARSE FUNCTION ======

export function parseTransferRouterDeployConfig(
  config: unknown,
): TransferRouterDeployConfig {
  return TransferRouterDeployConfigSchema.parse(config);
}
