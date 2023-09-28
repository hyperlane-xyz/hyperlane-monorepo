import { z } from 'zod';

import { HyperlaneContractsMap } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../utils/files.js';

const DeploymentArtifactsSchema = z
  .object({})
  .catchall(z.object({}).catchall(z.string()));

export function readDeploymentArtifacts(filePath: string) {
  const artifacts = readYamlOrJson<HyperlaneContractsMap<any>>(filePath);
  if (!artifacts) throw new Error(`No artifacts found at ${filePath}`);
  const result = DeploymentArtifactsSchema.safeParse(artifacts);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid artifacts: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return artifacts;
}
