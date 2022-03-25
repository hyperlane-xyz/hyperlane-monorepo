import { createAgentGCPKeys } from '../src/agents/gcp';
import { getEnvironment, getDomainNames } from './utils';

async function main() {
  const environment = await getEnvironment();
  const domainNames = await getDomainNames(environment);

  return createAgentGCPKeys(environment, domainNames);
}

main().then(console.log).catch(console.error);
