import { deleteAgentGCPKeys } from '../src/agents/gcp';

import { getDomainNames, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const domainNames = await getDomainNames(environment);

  return deleteAgentGCPKeys(environment, domainNames);
}

main().then(console.log).catch(console.error);
