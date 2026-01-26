import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';

import { rootLogger } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';

const execAsync = promisify(exec);

export async function validateRegistryCommit(commit: string) {
  const registry = getRegistry();
  const registryUri = registry.getUri();

  try {
    rootLogger.info(
      chalk.grey.italic(`Attempting to fetch registry commit ${commit}...`),
    );
    await execAsync(`cd ${registryUri} && git fetch origin ${commit}`, {
      timeout: 60000, // 60 second timeout
    });
    rootLogger.info(chalk.grey.italic('Fetch completed successfully.'));
  } catch (_) {
    rootLogger.error(chalk.red(`Unable to fetch registry commit ${commit}.`));
    process.exit(1);
  }
}
