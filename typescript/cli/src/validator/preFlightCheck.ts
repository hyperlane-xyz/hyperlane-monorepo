import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { HyperlaneCore, S3Validator } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

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
    const [_, latestCheckpointIndex] = await merkleTreeHook.latestCheckpoint();

    merkleTreeLatestCheckpointIndex = latestCheckpointIndex;
    logBlue(
      `\nLatest checkpoint index of incremental merkle tree: ${merkleTreeLatestCheckpointIndex}\n`,
    );
  } catch (err) {
    warnYellow(
      `❗️ Failed to fetch latest checkpoint index of merkleTreeHook on ${chain}: ${err} \n`,
    );
  }

  const errorSet = new Set<string>();

  const validatorsArray = Array.from(validators);
  let validatorStorageLocations: string[][] | undefined;

  try {
    validatorStorageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(validatorsArray);
  } catch {
    errorSet.add('Failed to read announced storage locations on chain.');
  }

  if (validatorStorageLocations) {
    for (let i = 0; i < validatorsArray.length; i++) {
      const validator = validatorsArray[i];
      const storageLocations = validatorStorageLocations[i];

      if (storageLocations.length === 0) {
        errorRed(`❌ Validator ${validator} has not been announced\n`);
        errorSet.add('Some validators have not been announced.');
        continue;
      }

      const s3StorageLocation = storageLocations[0];

      let s3Validator: S3Validator;
      try {
        s3Validator = await S3Validator.fromStorageLocation(s3StorageLocation);
      } catch {
        errorRed(
          `❌ Failed to fetch storage locations for validator ${validator}, this may be due to the storage location not being an S3 bucket\n\n`,
        );
        errorSet.add('Failed to fetch storage locations for some validators.');
        continue;
      }

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
            `Some validators are not signing the latest available checkpoint`,
          );
        } else {
          logBlue(
            `✅ Validator is signing the latest available checkpoint\n\n`,
          );
        }
      } else {
        warnYellow(
          `❗️ Cannot compare validator checkpoint signatures to latest checkpoint in the incremental merkletree, merkletree checkpoint could not be read\n`,
        );
      }
    }
  }

  if (errorSet.size > 0) {
    errorRed(
      `\n❌ Validator pre flight check failed:\n${Array.from(errorSet).join(
        '\n',
      )}`,
    );
    process.exit(1);
  } else {
    logGreen(`\n✅ Validator pre flight check passed`);
  }
};
