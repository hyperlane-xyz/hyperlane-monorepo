import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { createAgentKeysIfNotExistsWithPrompt } from '../../src/agents/key-utils.js';
import { getAgentConfigsBasedOnArgs } from '../agent-utils.js';

async function main() {
  const { agentConfig } = await getAgentConfigsBasedOnArgs();

  const created = await createAgentKeysIfNotExistsWithPrompt(agentConfig);

  if (created) {
    return 'Keys created successfully!';
  } else {
    return 'No new keys are created!';
  }
}

main().then(console.log).catch(console.error);
