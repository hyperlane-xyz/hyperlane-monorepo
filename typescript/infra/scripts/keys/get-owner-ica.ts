import { IRegistry } from '@hyperlane-xyz/registry';
import {
  AccountConfig,
  ChainName,
  InterchainAccount,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
  eqAddress,
  isZeroishAddress,
  mapAllSettled,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { icaOwnerChain } from '../../config/environments/mainnet3/owners.js';
import {
  chainsToSkip,
  legacyEthIcaRouter,
  legacyIcaChains,
} from '../../src/config/chain.js';
import { withGovernanceType } from '../../src/governance.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import {
  getArgs as getEnvArgs,
  withChains,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function getGovernanceOwnerFromWarpConfig(
  registry: IRegistry,
  warpRouteId: string,
  chain: ChainName,
) {
  const warpConfig = await registry.getWarpDeployConfig(warpRouteId);
  assert(warpConfig, `Warp config not found for warpRouteID ${warpRouteId}`);
  const chainConfig = warpConfig[chain];
  assert(
    chainConfig,
    `Warp config missing chain ${chain} for warpRouteID ${warpRouteId}`,
  );
  assert(
    chainConfig.owner,
    `Owner not configured for chain ${chain} in warpRouteID ${warpRouteId}`,
  );
  return chainConfig.owner;
}

function getArgs() {
  return withGovernanceType(withChains(withWarpRouteId(getEnvArgs())))
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
    warpRouteId,
  } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // If warpRouteId is provided, get the governanceOwner from the warp config and ownerChain
  // or the safe owner for the given governance type
  const governanceOwner = warpRouteId
    ? await getGovernanceOwnerFromWarpConfig(
        await config.getRegistry(),
        warpRouteId,
        ownerChain,
      )
    : getGovernanceSafes(governanceType)[ownerChain];
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
  const { fulfilled, rejected } = await mapAllSettled(
    getOwnerIcaChains,
    async (chain) => {
      const icaRouter = legacyIcaChains.includes(chain)
        ? legacyEthIcaRouter
        : ownerChainInterchainAccountRouter;

      try {
        const account = await ica.getAccount(chain, {
          ...ownerConfig,
          localRouter: icaRouter,
        });
        const result: { ICA: Address; Deployed?: string } = { ICA: account };

        if (deploy) {
          const deployedAccount = await ica.deployAccount(chain, {
            ...ownerConfig,
            localRouter: icaRouter,
          });
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
    },
    (chain) => chain,
  );

  for (const [chain, value] of fulfilled) {
    if ('error' in value || !value.result) {
      rootLogger.error(
        `Failed to process ${chain}:`,
        'error' in value ? value.error : 'Unknown error',
      );
    } else {
      results[chain] = value.result;
    }
  }

  for (const [chain, error] of rejected) {
    rootLogger.error(`Promise rejected for ${chain}:`, error);
  }

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
