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
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    chains,
    all = false,
    validator,
    alias: aliasFilter,
    ready: readyFilter,
  } = await withChains(getArgs())
    .describe('all', 'all validators, including non-default ISM')
    .boolean('all')
    .alias('a', 'all')
    .describe('validator', 'specific validator address to check')
    .string('validator')
    .alias('v', 'validator')
    .describe(
      'alias',
      'filter to validators whose default ISM alias matches this string (case-insensitive substring match, e.g. "Abacus Works")',
    )
    .string('alias')
    .describe(
      'ready',
      'filter by readable latest checkpoint; use --ready or --ready=false',
    )
    .boolean('ready').argv;

  // Get multiprovider for target networks
  const envConfig = getEnvironmentConfig(environment);

  // Default to every chain in the environment when --chains is omitted
  const requestedChains =
    chains && chains.length > 0 ? chains : envConfig.supportedChainNames;

  const targetNetworks = requestedChains.filter((chain) => {
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
        ready: boolean;
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

  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    targetNetworks,
  );

  await Promise.all(
    targetNetworks.map(async (chain) => {
      let announcedValidators: Address[];
      let storageLocations: string[][];
      try {
        const validatorAnnounce = ValidatorAnnounce__factory.connect(
          chainAddresses[chain]['validatorAnnounce'],
          multiProvider.getProvider(chain),
        );

        announcedValidators = await validatorAnnounce.getAnnouncedValidators();
        storageLocations =
          await validatorAnnounce.getAnnouncedStorageLocations(
            announcedValidators,
          );
      } catch (error) {
        rootLogger.error(
          `Error fetching announced validators for chain ${chain}: ${error}`,
        );
        return;
      }

      const defaultIsmValidators =
        defaultMultisigConfigs[chain]?.validators || [];

      const findDefaultValidatorAlias = (address: Address): string => {
        const validator = defaultIsmValidators.find((v) =>
          eqAddress(v.address, address),
        );
        return validator?.alias || '';
      };

      // For each validator on this chain
      for (let i = 0; i < announcedValidators.length; i++) {
        const validatorAddress = announcedValidators[i];
        const location = storageLocations[i][storageLocations[i].length - 1];

        // If a specific validator address is provided, only process that one
        if (validator && !eqAddress(validatorAddress, validator)) {
          continue;
        }

        // If it's not a core chain, then we'll want to check all announced validators
        const isDefaultIsmValidator =
          findDefaultValidatorAlias(validatorAddress);

        if (aliasFilter) {
          // --alias takes precedence: only keep validators whose alias matches
          if (
            !isDefaultIsmValidator
              .toLowerCase()
              .includes(aliasFilter.toLowerCase())
          ) {
            continue;
          }
        } else if (
          // Skip validators not in default ISM unless --all flag is set or specific validator is provided
          defaultIsmValidators.length > 0 &&
          !isDefaultIsmValidator &&
          !all &&
          !validator
        ) {
          continue;
        }

        // Get metadata from each storage location
        try {
          const validatorInstance =
            await getValidatorFromStorageLocation(location);

          const latestCheckpoint =
            await validatorInstance.getLatestCheckpointIndex();
          const bucket = validatorInstance.getLatestCheckpointUrl();
          const ready = latestCheckpoint >= 0;

          if (readyFilter !== undefined && readyFilter !== ready) {
            continue;
          }

          if (!validators[chain]) {
            validators[chain] = {};
          }

          const alias = findDefaultValidatorAlias(validatorAddress);
          validators[chain][validatorAddress] = {
            alias,
            default: alias ? '✅' : '',
            latest: latestCheckpoint,
            ready,
            bucket,
          };
        } catch (error) {
          if (readyFilter === true) {
            continue;
          }

          // Only log errors for default ISM validators. This is because
          // non-default ISM validators may be configured with bogus
          // signature locations, which will cause errors when trying to
          // get metadata.
          const logLevel = isDefaultIsmValidator ? 'error' : 'debug';
          rootLogger[logLevel](
            `Error getting metadata for ${validatorAddress} on chain ${chain}: ${error}`,
          );
          if (!validators[chain]) {
            validators[chain] = {};
          }
          validators[chain][validatorAddress] = {
            alias: '',
            default: '',
            latest: -1,
            ready: false,
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
    console.table(sortedValidators, [
      'alias',
      'default',
      'latest',
      'ready',
      'bucket',
    ]);
  });

  process.exit(0);
}

main().catch(rootLogger.error);
