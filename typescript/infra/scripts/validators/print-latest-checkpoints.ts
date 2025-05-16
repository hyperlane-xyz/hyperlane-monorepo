import { ValidatorAnnounce__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  defaultMultisigConfigs,
  getValidatorFromStorageLocation,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  LogFormat,
  LogLevel,
  configureRootLogger,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChainAddresses } from '../../config/registry.js';
import { Role } from '../../src/roles.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChainsRequired } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    chains,
    all = false,
  } = await withChainsRequired(getArgs())
    .describe('all', 'all validators, including non-default ISM')
    .boolean('all')
    .alias('a', 'all').argv;

  if (chains.length === 0) {
    rootLogger.error('Must provide at least one chain');
    process.exit(1);
  }

  const targetNetworks = chains.filter((chain) => {
    const isEthereum = isEthereumProtocolChain(chain);
    if (!isEthereum) {
      rootLogger.info(`Skipping non-Ethereum chain: ${chain}`);
    }
    return isEthereum;
  });

  const validators: ChainMap<
    Record<
      Address,
      {
        alias: string;
        default: string;
        latest: number;
        bucket: string;
      }
    >
  > = {};

  // Filter to only include target networks
  const chainAddresses = Object.fromEntries(
    Object.entries(getChainAddresses()).filter(([chain, _]) =>
      targetNetworks.includes(chain),
    ),
  );

  // Get multiprovider for target networks
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    targetNetworks,
  );

  await Promise.all(
    targetNetworks.map(async (chain) => {
      if (chain === 'lumia') {
        rootLogger.info('Skipping deprecated chain: lumia');
        return;
      }

      const validatorAnnounce = ValidatorAnnounce__factory.connect(
        chainAddresses[chain]['validatorAnnounce'],
        multiProvider.getProvider(chain),
      );

      const announcedValidators =
        await validatorAnnounce.getAnnouncedValidators();
      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations(
          announcedValidators,
        );

      const defaultIsmValidators =
        defaultMultisigConfigs[chain]?.validators || [];

      const findDefaultValidatorAlias = (address: Address): string => {
        const validator = defaultIsmValidators.find((v) =>
          eqAddress(v.address, address),
        );
        return validator?.alias || '';
      };

      // Check if the chain is a core chain
      // If it's not a core chain, then we'll want to check all announced validators
      const isCoreChain = defaultMultisigConfigs[chain] !== undefined;

      // For each validator on this chain
      for (let i = 0; i < announcedValidators.length; i++) {
        const validator = announcedValidators[i];
        const location = storageLocations[i][storageLocations[i].length - 1];

        // Skip validators not in default ISM unless --all flag is set
        const isDefaultIsmValidator = findDefaultValidatorAlias(validator);
        if (isCoreChain && !isDefaultIsmValidator && !all) {
          continue;
        }

        // Get metadata from each storage location
        try {
          const validatorInstance =
            await getValidatorFromStorageLocation(location);

          const latestCheckpoint =
            await validatorInstance.getLatestCheckpointIndex();
          const bucket = validatorInstance.getLatestCheckpointUrl();

          if (!validators[chain]) {
            validators[chain] = {};
          }
          const alias = findDefaultValidatorAlias(validator);
          validators[chain][validator] = {
            alias,
            default: alias ? '✅' : '',
            latest: latestCheckpoint,
            bucket,
          };
        } catch (error) {
          // Only log errors for default ISM validators. This is because
          // non-default ISM validators may be configured with bogus
          // signature locations, which will cause errors when trying to
          // get metadata.
          const logLevel = isDefaultIsmValidator ? 'error' : 'debug';
          rootLogger[logLevel](
            `Error getting metadata for ${validator} on chain ${chain}: ${error}`,
          );
          validators[chain][validator] = {
            alias: '',
            default: '',
            latest: -1,
            bucket: location,
          };
        }
      }
    }),
  );

  // Print table for each chain's validators
  Object.entries(validators).forEach(([chain, chainValidators]) => {
    const { displayName } = multiProvider.getChainMetadata(chain);
    rootLogger.info(`\n${displayName ?? chain} Validators:`);
    // Sort validators by default (✅ first), then by latest checkpoint index
    const sortedValidators = Object.fromEntries(
      Object.entries(chainValidators).sort(([, a], [, b]) => {
        if (a.default !== b.default) {
          return b.default.localeCompare(a.default); // ✅ comes before empty string
        }
        return b.latest - a.latest;
      }),
    );
    // eslint-disable-next-line no-console
    console.table(sortedValidators, ['alias', 'default', 'latest', 'bucket']);
  });

  process.exit(0);
}

main().catch(rootLogger.error);
