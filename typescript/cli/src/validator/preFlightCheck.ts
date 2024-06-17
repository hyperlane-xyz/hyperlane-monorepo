import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { HyperlaneCore, S3Validator } from '@hyperlane-xyz/sdk';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen, warnYellow } from '../logger.js';

export const checkValidatorSetup = async (
  context: CommandContext,
  chain: string,
  validators: Set<Address>,
) => {
  const { multiProvider, registry } = context;

  const addresses = await registry.getAddresses();

  const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);

  const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
  const merkleTreeHook = MerkleTreeHook__factory.connect(
    addresses[chain].merkleTreeHook,
    multiProvider.getProvider(chain),
  );

  let merkleTreeLatestCheckpointIndex: number | undefined;
  try {
    const [_, latestCheckpointIndex] = await merkleTreeHook[
      'latestCheckpoint()'
    ]();

    merkleTreeLatestCheckpointIndex = latestCheckpointIndex;
    logBlue(
      `\nLatest check point index of incremental merkle tree: ${merkleTreeLatestCheckpointIndex}\n`,
    );
  } catch (err) {
    warnYellow(
      `❗️ Failed to fetch latest checkpoint index of merkleTreeHook on ${chain} \n`,
    );
  }

  let announcedValidators;
  try {
    announcedValidators = await validatorAnnounce.getAnnouncedValidators();
  } catch (err) {
    errorRed(
      `❌ Failed to fetch announced validators for ${chain}. Exiting.\n`,
    );
    process.exit(1);
  }

  const confirmedValidators = new Set<Address>();
  const unconfirmedValidators = new Set<Address>();

  for (const validator of validators) {
    const matches = announcedValidators.filter((address) =>
      eqAddress(address, validator),
    );
    if (matches.length === 0) {
      unconfirmedValidators.add(validator);
    } else {
      confirmedValidators.add(validator);
    }
  }

  const errorSet = new Set<string>();
  errorSet.add('Validator pre flight check failed:');

  if (unconfirmedValidators.size > 0) {
    errorSet.add('Some validators have not been announced.');
  }

  let failedToReadError = false;
  for (const validator of confirmedValidators) {
    let storageLocations;
    try {
      storageLocations = await validatorAnnounce.getAnnouncedStorageLocations([
        validator,
      ]);
      const s3StorageLocation = storageLocations[0][0];

      const s3Validator = await S3Validator.fromStorageLocation(
        s3StorageLocation,
      );

      const latestCheckpointIndex =
        await s3Validator.getLatestCheckpointIndex();

      logBlue(
        `✅ Validator ${validator} announced\nstorage location: ${s3StorageLocation}\nlatest checkpoint index: ${latestCheckpointIndex}`,
      );

      // check is latestCheckpointIndex is within 1% of the merkleTreeLatestCheckpointIndex
      if (merkleTreeLatestCheckpointIndex) {
        const diff = Math.abs(
          latestCheckpointIndex - merkleTreeLatestCheckpointIndex,
        );
        if (diff > merkleTreeLatestCheckpointIndex / 100) {
          errorRed(
            `❌ Validator is not signing the latest available checkpoint\n\n`,
          );
          errorSet.add(
            `Some validators are not signing the latest available checkpoint\n`,
          );
        } else {
          logBlue(
            `✅ Validator is signing the latest available checkpoint\n\n`,
          );
        }
      } else {
        warnYellow(
          `❗️ Cannot compare validator checkpoint signatures to latest check point \n`,
        );
      }
    } catch (err) {
      errorRed(
        `❌ Failed to fetch storage locations for validator ${validator}, this may be due to the storage location not being an S3 bucket\n\n`,
      );
      failedToReadError = true;
    }
  }

  for (const validator of unconfirmedValidators) {
    errorRed(`❌ Validator ${validator} has not been announced\n`);
  }

  if (failedToReadError) {
    errorSet.add('Failed to fetch storage locations for some validators.');
  }

  if (errorSet.size > 1) {
    errorRed(`\n❌ ${Array.from(errorSet).join('\n')}`);
    process.exit(1);
  } else {
    logGreen(`\n✅ Validator pre flight check passed`);
  }
};
