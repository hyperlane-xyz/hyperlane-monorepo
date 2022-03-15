import { createAgentGCPKeys } from '../src/agents/gcp';
import { getEnvironment, getChainConfigs } from './utils';

async function main() {
  const environment = await getEnvironment();
  const chains = await getChainConfigs(environment);

  return createAgentGCPKeys(
    environment,
    Object.values(chains).map((c) => c.name),
  );
}

main().then(console.log).catch(console.error);
