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
  rootLogger,
} from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChainsRequired } from '../agent-utils.js';
import { getHyperlaneCore } from '../core-utils.js';

function getHttpsUrl(storageLocation: string): string {
  if (storageLocation.startsWith('s3://')) {
    // Convert s3:///bucket-name/region to https://bucket-name.s3.region.amazonaws.com
    const [, , bucket, region] = storageLocation.split('/');
    return `https://${bucket}.s3.${region}.amazonaws.com`;
  } else if (storageLocation.startsWith('gs://')) {
    // Convert gs://bucket-name to https://storage.googleapis.com/bucket-name
    const bucket = storageLocation.replace('gs://', '');
    return `https://storage.googleapis.com/${bucket}`;
  }
  return storageLocation;
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, chains } = await withChainsRequired(getArgs()).argv;

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
        latest: number;
        bucket: string;
      }
    >
  > = {};

  // Manually add validator announce for OG Lumia chain deployment
  const { core, multiProvider } = await getHyperlaneCore(environment);
  const lumiaValidatorAnnounce = ValidatorAnnounce__factory.connect(
    '0x989B7307d266151BE763935C856493D968b2affF',
    multiProvider.getProvider('lumia'),
  );

  await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce =
        chain === 'lumia'
          ? lumiaValidatorAnnounce
          : core.getContracts(chain).validatorAnnounce;
      const expectedValidators = defaultMultisigConfigs[chain].validators || [];
      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations(
          expectedValidators.map((v) => v.address),
        );

      // For each validator on this chain
      for (let i = 0; i < expectedValidators.length; i++) {
        const { address: validator, alias } = expectedValidators[i];
        const location = storageLocations[i][0];

        // Get metadata from each storage location
        try {
          const validatorInstance = await getValidatorFromStorageLocation(
            location,
          );

          const latestCheckpoint =
            await validatorInstance.getLatestCheckpointIndex();
          const bucket = getHttpsUrl(
            validatorInstance.getLatestCheckpointUrl(),
          );

          if (!validators[chain]) {
            validators[chain] = {};
          }
          validators[chain][validator] = {
            alias,
            latest: latestCheckpoint,
            bucket,
          };
        } catch (error) {
          rootLogger.warn(
            `Error getting metadata for ${validator} on chain ${chain}: ${error}`,
          );
        }
      }
    }),
  );

  // Print table for each chain's validators
  Object.entries(validators).forEach(([chain, chainValidators]) => {
    const { displayName } = multiProvider.getChainMetadata(chain);
    rootLogger.info(`\n${displayName ?? chain} Validators:`);
    // eslint-disable-next-line no-console
    console.table(chainValidators, ['alias', 'latest', 'bucket']);
  });

  process.exit(0);
}

main().catch(rootLogger.error);
