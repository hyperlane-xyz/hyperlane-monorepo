import { getAgentConfigsBasedOnArgs } from './agent-utils';

async function main() {
  const { agentConfig, newThresholds } = await getAgentConfigsBasedOnArgs();
  console.log(
    'Creating keys for agent config:',
    newThresholds,
    JSON.stringify(agentConfig, null, 2),
  );
  // await createAgentKeysIfNotExists(agentConfig, newThresholds);
  return 'Keys created successfully!';
}

main().then(console.log).catch(console.error);
