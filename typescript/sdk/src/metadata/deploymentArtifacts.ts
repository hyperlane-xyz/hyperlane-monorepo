import { z } from 'zod';

import { ChainMetadataSchema } from './chainMetadataTypes';

export const HyperlaneDeploymentArtifactsSchema = z.object({
  mailbox: z.string().describe('The address of the Mailbox contract.'),
  interchainGasPaymaster: z
    .string()
    .describe('The address of the Interchain Gas Paymaster (IGP) contract.'),
  validatorAnnounce: z
    .string()
    .describe('The address of the Validator Announce contract.'),
  interchainSecurityModule: z
    .string()
    .optional()
    .describe('The address of the Interchain Security Module (ISM) contract.'),
});

export type HyperlaneDeploymentArtifacts = z.infer<
  typeof HyperlaneDeploymentArtifactsSchema
>;

export const ChainMetadataWithArtifactsSchema = ChainMetadataSchema.merge(
  HyperlaneDeploymentArtifactsSchema,
);

export type ChainMetadataWithArtifacts = z.infer<
  typeof ChainMetadataWithArtifactsSchema
>;
