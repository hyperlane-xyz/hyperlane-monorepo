import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import { Address, assert, eqAddress } from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../src/utils/utils.js';

import { getArgs as getEnvArgs, withChains } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

function getArgs() {
  return withChains(getEnvArgs())
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
    .alias('chains', 'destinationChains').argv;
}

async function main() {
  const {
    environment,
    ownerChain,
    chains,
    deploy,
    owner: ownerOverride,
  } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const chainsToProcess = chains?.length ? chains : config.supportedChainNames;
  const multiProvider = await config.getMultiProvider();

  const originOwner = ownerOverride ?? config.owners[ownerChain]?.owner;
  if (!originOwner) {
    throw new Error(`No owner found for ${ownerChain}`);
  }

  console.log(`Governance owner on ${ownerChain}: ${originOwner}`);

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  const ownerConfig: AccountConfig = {
    origin: ownerChain,
    owner: originOwner,
  };

  const results: Record<string, { ICA: Address; Deployed?: string }> = {};
  for (const chain of chainsToProcess.filter(isEthereumProtocolChain)) {
    const account = await ica.getAccount(chain, ownerConfig);
    results[chain] = { ICA: account };

    if (deploy) {
      const deployedAccount = await ica.deployAccount(chain, ownerConfig);
      assert(
        eqAddress(account, deployedAccount),
        'Fatal mismatch between account and deployed account',
      );
      results[chain].Deployed = '✅';
    }
  }

  console.table(results);
}

main()
  .then()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
