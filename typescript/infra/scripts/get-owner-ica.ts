import { ethers } from 'ethers';

import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import { assert, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { getSecretRpcEndpoints } from '../src/agents/index.js';

import { getArgs as getEnvArgs, withChainRequired } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

function getArgs() {
  return withChainRequired(getEnvArgs())
    .option('ownerChain', {
      type: 'string',
      description: 'Origin chain where the governing owner lives',
      demandOption: true,
    })
    .option('owner', {
      type: 'string',
      description:
        "Address of the owner on the ownerChain. Defaults to the environment's configured owner for the ownerChain.",
      demandOption: false,
    })
    .option('deploy', {
      type: 'boolean',
      description: 'Deploys the ICA if it does not exist',
      default: false,
    })
    .alias('chain', 'destinationChain').argv;
}

async function main() {
  const {
    environment,
    ownerChain,
    chain,
    deploy,
    owner: ownerOverride,
  } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const originOwner = ownerOverride ?? config.owners[ownerChain]?.owner;
  if (!originOwner) {
    throw new Error(`No owner found for ${ownerChain}`);
  }

  rootLogger.info(`Governance owner on ${ownerChain}: ${originOwner}`);

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  const ownerConfig: AccountConfig = {
    origin: ownerChain,
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
