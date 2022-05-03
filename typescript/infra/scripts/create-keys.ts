import { utils } from '@abacus-network/deploy';

import { createAgentGCPKeys } from '../src/agents/gcp';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  const domains = Object.keys(config.transactionConfigs);

  const { v: validatorCount } = await utils
    .getArgs()
    .alias('v', 'validatorCount')
    .number('v')
    .demandOption('v').argv;

  return createAgentGCPKeys(environment, domains, validatorCount);
}

main().then(console.log).catch(console.error);
