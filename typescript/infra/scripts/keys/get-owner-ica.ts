import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import {
  Address,
  LogFormat,
  LogLevel,
  configureRootLogger,
  eqAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { icaOwnerChain } from '../../config/environments/mainnet3/owners.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { withGovernanceType } from '../../src/governance.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs as getEnvArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

function getArgs() {
  return withGovernanceType(withChains(getEnvArgs()))
    .option('ownerChain', {
      type: 'string',
      description: 'Origin chain where the governing owner lives',
      demandOption: true,
      default: icaOwnerChain,
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
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const {
    environment,
    ownerChain,
    chains,
    deploy,
    owner: ownerOverride,
    governanceType,
  } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // Get the safe owner for the given governance type
  const governanceOwner = getGovernanceSafes(governanceType)[ownerChain];
  const originOwner = ownerOverride ?? governanceOwner;
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
  const ownerChainInterchainAccountRouter =
    ica.contractsMap[ownerChain].interchainAccountRouter.address;

  if (isZeroishAddress(ownerChainInterchainAccountRouter)) {
    rootLogger.error(`Interchain account router address is zero`);
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
            rootLogger.warn(
              `Mismatch between account and deployed account for ${chain}`,
            );
          }
        }

        return { chain, result };
      } catch (error) {
        rootLogger.error(`Error processing chain ${chain}:`, error);
        return { chain, error };
      }
    }),
  );

  settledResults.forEach((settledResult) => {
    if (settledResult.status === 'fulfilled') {
      const { chain, result, error } = settledResult.value;
      if (error || !result) {
        rootLogger.error(`Failed to process ${chain}:`, error);
      } else {
        results[chain] = result;
      }
    } else {
      rootLogger.error(`Promise rejected:`, settledResult.reason);
    }
  });

  // eslint-disable-next-line no-console
  console.table(results);
  process.exit(0);
}

main()
  .then()
  .catch((err) => {
    rootLogger.error('Error:', err);
    process.exit(1);
  });
