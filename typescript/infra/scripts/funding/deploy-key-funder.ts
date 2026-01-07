import { confirm, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join } from 'path';

import { Contexts } from '../../config/contexts.js';
import { KeyFunderHelmManager } from '../../src/funding/key-funder.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { getMonorepoRoot } from '../../src/utils/utils.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

function readRegistryRc(): string {
  const registryRcPath = join(getMonorepoRoot(), '.registryrc');
  return readFileSync(registryRcPath, 'utf-8').trim();
}

async function main() {
  const { agentConfig, envConfig, environment } = await getConfigsBasedOnArgs();
  if (agentConfig.context != Contexts.Hyperlane)
    throw new Error(
      `Invalid context ${agentConfig.context}, must be ${Contexts.Hyperlane}`,
    );

  await assertCorrectKubeContext(envConfig);

  const defaultRegistryCommit = readRegistryRc();
  console.log(
    chalk.gray(
      `Using registry commit from .registryrc: ${defaultRegistryCommit}`,
    ),
  );

  const shouldOverride = await confirm({
    message: 'Do you want to override the registry version?',
    default: false,
  });

  let registryCommit = defaultRegistryCommit;
  if (shouldOverride) {
    registryCommit = await input({
      message:
        'Enter the registry version to use (can be a commit, branch or tag):',
    });
  }

  await validateRegistryCommit(registryCommit);

  const manager = KeyFunderHelmManager.forEnvironment(
    environment,
    registryCommit,
  );
  await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
