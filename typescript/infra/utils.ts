import chalk from 'chalk';
import { execSync } from 'child_process';

import { rootLogger } from '@hyperlane-xyz/utils';

import { getRegistry } from './config/registry.js';

export async function validateRegistryCommit(commit: string) {
  const registry = getRegistry();
  const registryUri = registry.getUri();

  try {
    rootLogger.info(
      chalk.grey.italic(`Attempting to fetch registry commit ${commit}...`),
    );
    execSync(`cd ${registryUri} && git fetch origin ${commit}`, {
      stdio: 'inherit',
    });
    rootLogger.info(chalk.grey.italic('Fetch completed successfully.'));
  } catch (_) {
    rootLogger.error(chalk.red(`Unable to fetch registry commit ${commit}.`));
    process.exit(1);
  }
}
