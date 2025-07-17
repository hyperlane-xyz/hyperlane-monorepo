import { EvmTimelockDeployer } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { awIcasV2 } from '../../config/environments/mainnet3/governance/ica/aw2.js';
import { regularIcasV2 } from '../../config/environments/mainnet3/governance/ica/regular2.js';
import {
  getGovernanceSafes,
  getGovernanceTimelocks,
} from '../../config/environments/mainnet3/governance/utils.js';
import { icaOwnerChain } from '../../config/environments/mainnet3/owners.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { GovernanceType, withGovernanceType } from '../../src/governance.js';
import {
  getTimelockConfigs,
  timelockConfigMatches,
} from '../../src/utils/timelock.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs as getEnvArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

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
      description: 'Deploys the timelocks if they do not exist',
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

  if (
    governanceType !== GovernanceType.AbacusWorks &&
    governanceType !== GovernanceType.Regular
  ) {
    throw new Error(
      `Governance type ${governanceType} not supported. Only AbacusWorks and Regular are supported.`,
    );
  }

  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // Get the safe owner for the given governance type
  const governanceOwner = getGovernanceSafes(governanceType)[ownerChain];
  const originOwner = ownerOverride ?? governanceOwner;
  if (!originOwner) {
    throw new Error(`No owner found for ${ownerChain}`);
  }

  rootLogger.info(`Governance owner on ${ownerChain}: ${originOwner}`);

  const timelockDeployer = new EvmTimelockDeployer(multiProvider, true);

  const governanceIcas =
    governanceType === GovernanceType.AbacusWorks ? awIcasV2 : regularIcasV2;
  const governanceTimelocks = getGovernanceTimelocks(governanceType);

  const getTimelockChains = (
    chains?.length ? chains : config.supportedChainNames
  ).filter(
    (chain) =>
      governanceIcas[chain] &&
      isEthereumProtocolChain(chain) &&
      !chainsToSkip.includes(chain) &&
      chain !== ownerChain,
  );

  // Configure timelocks for the given chains
  const timelockConfigs = getTimelockConfigs({
    chains: getTimelockChains,
    owners: governanceIcas,
  });

  const results: Record<string, { address?: string; status: string }> = {};

  await Promise.all(
    getTimelockChains.map(async (chain) => {
      const expectedConfig = timelockConfigs[chain];
      const timelockAddress = governanceTimelocks[chain];

      if (!timelockAddress) {
        results[chain] = { address: undefined, status: '❌' };
        return;
      }

      try {
        const matches = await timelockConfigMatches({
          multiProvider,
          chain,
          expectedConfig,
          address: timelockAddress,
        });
        results[chain] = {
          address: timelockAddress,
          status: matches ? '✅' : '❌',
        };

        // If the timelock matches, we don't need to deploy it again
        if (matches) {
          delete timelockConfigs[chain];
        } else {
          rootLogger.info(
            `Timelock ${chain} does not match expected config. May require redeployment.`,
          );
        }
      } catch (err) {
        results[chain] = { address: timelockAddress, status: '❌' };
        rootLogger.error(`Error checking timelock config for ${chain}:`, err);
      }
    }),
  );

  if (Object.keys(timelockConfigs).length === 0) {
    rootLogger.info('No timelocks to deploy');
  } else if (deploy) {
    const deployedTimelocks = await timelockDeployer.deploy(timelockConfigs);
    Object.entries(deployedTimelocks).forEach(
      ([chain, { TimelockController }]) => {
        results[chain] = {
          address: TimelockController.address,
          status: '✅',
        };
      },
    );
  }

  // eslint-disable-next-line no-console
  console.table(
    Object.entries(results).map(([chain, { address, status }]) => ({
      chain,
      address: address ?? '',
      status,
    })),
  );
}

main()
  .then()
  .catch((err) => {
    rootLogger.error('Error:', err);
    process.exit(1);
  });
