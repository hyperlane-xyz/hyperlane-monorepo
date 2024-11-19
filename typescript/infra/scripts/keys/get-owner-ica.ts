import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import { Address, eqAddress, isZeroishAddress } from '@hyperlane-xyz/utils';

import { chainsToSkip } from '../../src/config/chain.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs as getEnvArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

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
  const ownerChainInterchainAccountRouter =
    ica.contractsMap[ownerChain].interchainAccountRouter.address;

  if (isZeroishAddress(ownerChainInterchainAccountRouter)) {
    console.error(`Interchain account router address is zero`);
    process.exit(1);
  }

  const getOwnerIcaChains = (
    chains?.length ? chains : config.supportedChainNames
  ).filter(
    (chain) => isEthereumProtocolChain(chain) && !chainsToSkip.includes(chain),
  );

  const results: Record<string, { ICA: Address; Deployed?: string }> = {};
  const settledResults = await Promise.allSettled(
    getOwnerIcaChains.map(async (chain) => {
      try {
        const account = await ica.getAccount(
          chain,
          ownerConfig,
          ownerChainInterchainAccountRouter,
        );
        const result: { ICA: Address; Deployed?: string } = { ICA: account };

        if (deploy) {
          const deployedAccount = await ica.deployAccount(
            chain,
            ownerConfig,
            ownerChainInterchainAccountRouter,
          );
          result.Deployed = eqAddress(account, deployedAccount) ? '✅' : '❌';
          if (result.Deployed === '❌') {
            console.warn(
              `Mismatch between account and deployed account for ${chain}`,
            );
          }
        }

        return { chain, result };
      } catch (error) {
        console.error(`Error processing chain ${chain}:`, error);
        return { chain, error };
      }
    }),
  );

  settledResults.forEach((settledResult) => {
    if (settledResult.status === 'fulfilled') {
      const { chain, result, error } = settledResult.value;
      if (error || !result) {
        console.error(`Failed to process ${chain}:`, error);
      } else {
        results[chain] = result;
      }
    } else {
      console.error(`Promise rejected:`, settledResult.reason);
    }
  });

  console.table(results);
  process.exit(0);
}

main()
  .then()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
