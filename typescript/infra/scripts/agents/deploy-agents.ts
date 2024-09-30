import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';

import { createAgentKeysIfNotExists } from '../../src/agents/key-utils.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

import { AgentCli } from './utils.js';

async function fetchLatestMain() {
  try {
    console.log(
      chalk.grey.italic('Fetching latest changes from origin/main...'),
    );
    execSync('git fetch origin main', { stdio: 'inherit' });
    console.log(chalk.grey.italic('Fetch completed successfully.'));
  } catch (error) {
    console.error(chalk.red('Error fetching from origin/main:', error));
    process.exit(1);
  }
}

async function getCommitsBehindMain(): Promise<number> {
  // Fetch latest changes before checking if current branch is up-to-date
  await fetchLatestMain();

  try {
    console.log(
      chalk.grey.italic(
        'Checking if current branch is up-to-date with origin/main...',
      ),
    );
    const [behindCount] = execSync(
      'git rev-list --left-right --count origin/main...HEAD',
    )
      .toString()
      .trim()
      .split('\t');
    return parseInt(behindCount);
  } catch (error) {
    console.error(chalk.red('Error checking git status:', error));
    process.exit(1);
  }
}

async function main() {
  // Note the create-keys script should be ran prior to running this script.
  // At the moment, `runAgentHelmCommand` has the side effect of creating keys / users
  // if they do not exist. It's possible for a race condition to occur where creation of
  // a key / user that is used by multiple deployments (like Kathy),
  // whose keys / users are not chain-specific) will be attempted multiple times.
  // While this function still has these side effects, the workaround is to just
  // run the create-keys script first.
  const { agentConfig } = await getConfigsBasedOnArgs();
  await createAgentKeysIfNotExists(agentConfig);

  // Check if current branch is up-to-date with the main branch
  const commitsBehind = await getCommitsBehindMain();

  // If the current branch is not up-to-date with origin/main, prompt the user to continue
  if (commitsBehind > 0) {
    const shouldContinue = await confirm({
      message: chalk.yellow.bold(
        `Warning: Current branch is ${commitsBehind} commit${
          commitsBehind === 1 ? '' : 's'
        } behind origin/main. Are you sure you want to continue?`,
      ),
      default: false,
    });
    if (!shouldContinue) {
      console.log(chalk.red.bold('Exiting...'));
      process.exit(1);
    }
  } else {
    console.log(
      chalk.green.bold('Current branch is up-to-date with origin/main.'),
    );
  }

  await new AgentCli().runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(console.log)
  .catch((err) => {
    console.error('Error deploying agents:', err);
    process.exit(1);
  });
