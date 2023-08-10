import { z } from 'zod';

const HashRegex = /^(0x)?[0-9a-fA-F]{32,128}$/;

export const HyperlaneDeploymentArtifactsSchema = z.object({
  mailbox: z
    .string()
    .regex(HashRegex)
    .describe('The address of the Mailbox contract.'),
  interchainGasPaymaster: z
    .string()
    .regex(HashRegex)
    .describe('The address of the Interchain Gas Paymaster (IGP) contract.'),
  validatorAnnounce: z
    .string()
    .regex(HashRegex)
    .describe('The address of the Validator Announce contract.'),
  interchainSecurityModule: z
    .string()
    .regex(HashRegex)
    .optional()
    .describe('The address of the Interchain Security Module (ISM) contract.'),
});

export type HyperlaneDeploymentArtifacts = z.infer<
  typeof HyperlaneDeploymentArtifactsSchema
>;
