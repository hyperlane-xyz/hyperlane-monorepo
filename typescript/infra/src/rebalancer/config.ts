import fs from 'fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import {
  RebalancerConfigSchema,
  getStrategyChainNames,
} from '@hyperlane-xyz/rebalancer';

// Deployment settings belong to infra, not the runtime rebalancer schema.
const DeploymentMetadataSchema = z.strictObject({
  imageTag: z.string().min(1).optional(),
  imageDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  swapsXyzApiKeySecret: z.string().min(1).optional(),
  registryCommit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
});

export function readRebalancerConfig(configPath: string) {
  const content = fs.readFileSync(configPath, 'utf8');
  const input = z
    .looseObject({
      deployment: DeploymentMetadataSchema.optional(),
    })
    .parse(parse(content));
  const { deployment, ...runtimeInput } = input;
  const validation = RebalancerConfigSchema.safeParse(runtimeInput);
  if (!validation.success) {
    throw new Error(z.prettifyError(validation.error));
  }
  if (getStrategyChainNames(validation.data.strategy).length === 0) {
    throw new Error('No chains configured');
  }
  return {
    config: validation.data,
    deployment: deployment ?? {},
    // Keep input units (not the schema's transformed TTL in milliseconds).
    runtimeConfig: deployment ? stringify(runtimeInput) : content,
  };
}

export type RebalancerDeploymentConfig = ReturnType<
  typeof readRebalancerConfig
>;
