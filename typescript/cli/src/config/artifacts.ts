import { ZodTypeAny, z } from 'zod';

import { HyperlaneContractsMap } from '@hyperlane-xyz/sdk';

import { logBlue } from '../../logger.js';
import { readYamlOrJson } from '../utils/files.js';

const RecursiveObjectSchema: ZodTypeAny = z.lazy(() =>
  z.object({}).catchall(z.union([z.string(), RecursiveObjectSchema])),
);

const DeploymentArtifactsSchema = z.object({}).catchall(RecursiveObjectSchema);

export function readDeploymentArtifacts(filePath: string) {
  const artifacts = readYamlOrJson<HyperlaneContractsMap<any>>(filePath);

  if (!artifacts) throw new Error(`No artifacts found at ${filePath}`);
  const result = DeploymentArtifactsSchema.safeParse(artifacts);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    logBlue(
      `Read deployment artifacts from ${JSON.stringify(
        result.error.issues,
        null,
        4,
      )}`,
    );
    throw new Error(
      `Invalid artifacts: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  return artifacts;
}
