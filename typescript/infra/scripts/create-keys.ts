import { createAgentGCPKeys } from '../src/agents/gcp';
import { getArgs, getEnvironment, getDomainNames } from './utils';

async function main() {
  const environment = await getEnvironment();
  const domainNames = await getDomainNames(environment);

  const validatorCount = (
    await getArgs().alias('v', 'validatorCount').number('v').demandOption('v')
      .argv
  ).v;

  return createAgentGCPKeys(environment, domainNames, validatorCount);
}

main().then(console.log).catch(console.error);
