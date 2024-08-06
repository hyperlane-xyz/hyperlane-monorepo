import { ethers } from 'ethers';

import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import { assert, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { getSecretRpcEndpoints } from '../src/agents/index.js';

import { getArgs as getEnvArgs, withChainRequired } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

function getArgs() {
  return withChainRequired(getEnvArgs())
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
  const { environment, governChain, chain, deploy } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const originOwner = config.owners[governChain]?.owner;
  if (!originOwner) {
    throw new Error(`No owner found for ${governChain}`);
  }

  rootLogger.info(`Governance owner on ${governChain}: ${originOwner}`);

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  const ownerConfig: AccountConfig = {
    origin: governChain,
    owner: originOwner,
  };

  const account = await ica.getAccount(chain, ownerConfig);

  rootLogger.info(`ICA on ${chain}: ${account}`);

  if (deploy) {
    // Ensuring the account was deployed
    const deployedAccount = await ica.deployAccount(chain, ownerConfig);
    // This shouldn't ever happen, but let's be safe
    assert(
      eqAddress(account, deployedAccount),
      'Fatal mismatch between account and deployed account',
    );

    rootLogger.info(
      `ICA deployed or recovered on ${chain}: ${deployedAccount}`,
    );
  }
}

main()
  .then()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
