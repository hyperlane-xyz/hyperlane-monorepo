import { confirm } from '@inquirer/prompts';
import { ZodTypeAny, z } from 'zod';

import { ChainName, HyperlaneContractsMap } from '@hyperlane-xyz/sdk';

import { log, logBlue } from '../logger.js';
import { readYamlOrJson, runFileSelectionStep } from '../utils/files.js';

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

/**
 * Prompts the user to specify deployment artifacts, or to generate new ones if none are present or selected.
 * @returns the selected artifacts, or undefined if they are to be generated from scratch
 */
export async function runDeploymentArtifactStep({
  artifactsPath,
  message,
  selectedChains,
  defaultArtifactsPath = './artifacts',
  defaultArtifactsNamePattern = 'core-deployment',
  skipConfirmation = false,
  dryRun = false,
}: {
  artifactsPath?: string;
  message?: string;
  selectedChains?: ChainName[];
  defaultArtifactsPath?: string;
  defaultArtifactsNamePattern?: string;
  skipConfirmation?: boolean;
  dryRun?: boolean;
}): Promise<HyperlaneContractsMap<any> | undefined> {
  if (!artifactsPath) {
    if (skipConfirmation) return undefined;
    if (dryRun) defaultArtifactsNamePattern = 'dry-run_core-deployment';

    const useArtifacts = await confirm({
      message: message || 'Do you want use some existing contract addresses?',
    });
    if (!useArtifacts) return undefined;

    artifactsPath = await runFileSelectionStep(
      defaultArtifactsPath,
      'contract deployment artifacts',
      defaultArtifactsNamePattern,
    );
  }
  const artifacts = readDeploymentArtifacts(artifactsPath);

  if (selectedChains) {
    const artifactChains = Object.keys(artifacts).filter((c) =>
      selectedChains.includes(c),
    );
    if (artifactChains.length === 0) {
      log('No artifacts found for selected chains');
    } else {
      log(`Found existing artifacts for chains: ${artifactChains.join(', ')}`);
    }
  }

  return artifacts;
}
