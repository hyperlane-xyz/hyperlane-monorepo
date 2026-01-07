import { input } from '@inquirer/prompts';
import chalk from 'chalk';

import { Contexts } from '../../config/contexts.js';
import { KeyFunderHelmManager } from '../../src/funding/key-funder.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

async function main() {
  const { agentConfig, envConfig, environment } = await getConfigsBasedOnArgs();
  if (agentConfig.context != Contexts.Hyperlane)
    throw new Error(
      `Invalid context ${agentConfig.context}, must be ${Contexts.Hyperlane}`,
    );

  await assertCorrectKubeContext(envConfig);

  const registryCommit = await input({
    message:
      'Enter the registry version to use (can be a commit, branch or tag):',
  });
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
