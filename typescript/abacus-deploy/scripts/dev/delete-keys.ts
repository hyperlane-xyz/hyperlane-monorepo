import { deleteAgentGCPKeys } from '../../src/agents/gcp';
import { getChains } from '../../config/environments/dev/chains';

async function main() {
  const chains = await getChains();
  return deleteAgentGCPKeys(
    'dev',
    chains.map((c) => c.name),
  );
}

main().then(console.log).catch(console.error);
