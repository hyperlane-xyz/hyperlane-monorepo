import { ethers } from 'ethers';

import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getSecretRpcEndpoints } from '../src/agents/index.js';

import { getArgs as getEnvArgs } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

function getArgs() {
  return getEnvArgs()
    .option('governChain', {
      type: 'string',
      description: 'Origin chain where the governing owner lives',
      demandOption: true,
    })
    .option('deploy', {
      type: 'boolean',
      description: 'Deploys the ICA if it does not exist',
      default: false,
    })
    .alias('chain', 'destinationChain').argv;
}

async function main() {
  const { environment, governChain, destinationChain } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const originOwner = config.owners[governChain]?.owner;
  if (!originOwner) {
    throw new Error(`No owner found for ${governChain}`);
  }

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  const ownerConfig: AccountConfig = {
    origin: governChain,
    owner: originOwner,
  };
}

main()
  .then()
  .catch(() => process.exit(1));
