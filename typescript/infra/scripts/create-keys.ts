import { createAgentGCPKeys } from '../src/agents/gcp';
import { getEnvironment, getCoreEnvironmentConfig } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);

  return createAgentGCPKeys(environment, config.domains);
}

main().then(console.log).catch(console.error);
