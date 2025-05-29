import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import {
  agentKeysToBeCreated,
  createAgentKeysIfNotExists,
} from '../../src/agents/key-utils.js';
import { getAgentConfigsBasedOnArgs } from '../agent-utils.js';

async function main() {
  const { agentConfig } = await getAgentConfigsBasedOnArgs();

  const agentKeysToCreate = await agentKeysToBeCreated(agentConfig);

  if (agentKeysToCreate.length > 0) {
    const shouldContinue = await confirm({
      message: chalk.yellow.bold(
        `Warning: New agent key will be created: ${agentKeysToCreate}. Are you sure you want to continue?`,
      ),
      default: false,
    });
    if (!shouldContinue) {
      console.log(chalk.red.bold('Exiting...'));
      process.exit(1);
    }

    console.log(chalk.green.bold('Creating new agent key if needed.'));
    await createAgentKeysIfNotExists(agentConfig);
    return 'Keys created successfully!';
  } else {
    console.log(chalk.green.bold('No new agent key will be created.'));
    return 'No new keys are created!';
  }
}

main().then(console.log).catch(console.error);
