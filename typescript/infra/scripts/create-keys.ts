import { createAgentGCPKeys } from '../src/agents/gcp';
import { getArgs, getEnvironment, getDomainNames } from './utils';

async function main() {
  const environment = await getEnvironment();
  const domainNames = await getDomainNames(environment);

  const { v: validatorCount, kathy } = await getArgs()
    .alias('v', 'validatorCount')
    .number('v')
    .demandOption('v')
    .boolean('kathy')
    .demandOption('kathy').argv;

  return createAgentGCPKeys(environment, domainNames, validatorCount, kathy);
}

main().then(console.log).catch(console.error);
