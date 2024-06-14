import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { HyperlaneCore, S3Validator } from '@hyperlane-xyz/sdk';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen, warnYellow } from '../logger.js';

export const checkValidatorSetup = async (
  context: CommandContext,
  chain: string,
  validators: Address[],
) => {
  const { multiProvider, registry } = context;

  const addresses = await registry.getAddresses();

  const core = HyperlaneCore.fromAddressesMap(addresses, multiProvider);

  const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
  const merkleTreeHook = MerkleTreeHook__factory.connect(
    addresses[chain].merkleTreeHook,
    multiProvider.getProvider(chain),
  );

  try {
    const [_, latestCheckpointIndex] = await merkleTreeHook[
      'latestCheckpoint()'
    ]();
    logBlue(
      `\nLatest check point index of incremental merkle tree: ${latestCheckpointIndex}\n`,
    );
  } catch (err) {
    warnYellow('Failed to fetch latest checkpoint index of merkleTreeHook\n');
  }

  let announcedValidators;
  try {
    announcedValidators = await validatorAnnounce.getAnnouncedValidators();
  } catch (err) {
    errorRed('Failed to fetch announced validators\n');
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

  const errorList: string[] = [];
  if (unconfirmedValidators.size > 0) {
    errorList.push('Some validators have not been announced');
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
        `Validator ${validator} announced with storage locations: ${s3StorageLocation}, latest checkpoint index: ${latestCheckpointIndex}`,
      );
    } catch (err) {
      errorRed(`Failed to fetch storage locations for validator ${validator}`);
      failedToReadError = true;
    }
  }

  for (const validator of unconfirmedValidators) {
    errorRed(`Validator ${validator} has not been announced`);
  }

  if (failedToReadError) {
    errorList.push('Failed to fetch storage locations for some validators');
  }

  if (errorList.length > 0) {
    errorRed(`\n❌ ${errorList.join('\n')}`);
    process.exit(1);
  } else {
    logGreen(`\n✅ All validators have been announced`);
  }
};
