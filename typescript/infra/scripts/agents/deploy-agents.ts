import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';

import { createAgentKeysIfNotExistsWithPrompt } from '../../src/agents/key-utils.js';
import { RootAgentConfig } from '../../src/config/agent/agent.js';
import {
  checkAgentImageExists,
  checkMonorepoImageExists,
} from '../../src/utils/gcloud.js';
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
    const execResult = execSync(
      'git rev-list --left-right --count origin/main...HEAD',
    );

    // The output of the git command is something like:
    // $ git rev-list --left-right --count origin/main...HEAD
    // 0    2
    // We only care about the first number, which is the number of commits behind origin/main.
    const [behindCount] = execResult.toString().trim().split('\t');
    return parseInt(behindCount);
  } catch (error) {
    console.error(chalk.red('Error checking git status:', error));
    process.exit(1);
  }
}

async function checkDockerTagsExist(agentConfig: RootAgentConfig) {
  const imagesToCheck: { agent: string; tag?: string }[] = [
    { agent: 'scraper', tag: agentConfig.scraper?.docker.tag },
    { agent: 'validators', tag: agentConfig.validators?.docker.tag },
    { agent: 'relayer', tag: agentConfig.relayer?.docker.tag },
  ];

  let errors = false;
  for (const { agent, tag } of imagesToCheck) {
    if (tag) {
      const agentExists = await checkAgentImageExists(tag);
      if (!agentExists) {
        errors = true;

        console.log(
          chalk.red(
            `Agent ${chalk.bold(agent)} is configured with an invalid Docker image tag: ${chalk.bold(tag)}.`,
          ),
        );

        const monorepoExists = await checkMonorepoImageExists(tag);
        if (monorepoExists) {
          console.log(
            chalk.red(
              `You have accidentally configured ${chalk.bold(
                agent,
              )} with a monorepo image tag.`,
            ),
          );
        }
      } else {
        console.log(
          chalk.green(
            `Agent ${chalk.bold(agent)} is configured with a valid Docker image tag: ${chalk.bold(tag)}.`,
          ),
        );
      }
    }
  }

  if (errors) {
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
  await checkDockerTagsExist(agentConfig);

  await createAgentKeysIfNotExistsWithPrompt(agentConfig);

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
