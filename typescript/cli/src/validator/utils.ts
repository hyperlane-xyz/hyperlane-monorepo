import { MerkleTreeHook, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { getValidatorFromStorageLocation } from '@hyperlane-xyz/sdk';
import { BaseValidator } from '@hyperlane-xyz/utils';

import { logDebug } from '../logger.js';

export const getLatestMerkleTreeCheckpointIndex = async (
  merkleTreeHook: MerkleTreeHook,
  chainName?: string,
): Promise<number | undefined> => {
  try {
    const [_, latestCheckpointIndex] = await merkleTreeHook.latestCheckpoint();
    return latestCheckpointIndex;
  } catch (err) {
    const debugMessage = `Failed to get latest checkpoint index from merkleTreeHook contract ${
      chainName ? `on ${chainName}` : ''
    } : ${err}`;
    logDebug(debugMessage);
    return undefined;
  }
};

export const getValidatorStorageLocations = async (
  validatorAnnounce: ValidatorAnnounce,
  validators: string[],
  chainName?: string,
): Promise<string[][] | undefined> => {
  try {
    return await validatorAnnounce.getAnnouncedStorageLocations(validators);
  } catch (err) {
    const debugMessage = `Failed to get announced storage locations from validatorAnnounce contract ${
      chainName ? `on ${chainName}` : ''
    } : ${err}`;
    logDebug(debugMessage);
    return undefined;
  }
};

export const getLatestValidatorCheckpointIndexAndUrl = async (
  storageLocation: string,
): Promise<[number, string] | undefined> => {
  let validator: BaseValidator;
  try {
    validator = await getValidatorFromStorageLocation(storageLocation);
  } catch (err) {
    logDebug(
      `Failed to instantiate Validator at location ${storageLocation}: ${err}`,
    );
    return undefined;
  }
  try {
    const latestCheckpointIndex = await validator.getLatestCheckpointIndex();
    return [latestCheckpointIndex, validator.getLatestCheckpointUrl()];
  } catch (err) {
    logDebug(
      `Failed to get latest checkpoint index from Validator at location ${storageLocation}: ${err}`,
    );
    return undefined;
  }
};

export const isValidatorSigningLatestCheckpoint = (
  latestValidatorCheckpointIndex: number,
  latestMerkleTreeCheckpointIndex: number,
): boolean => {
  const diff = Math.abs(
    latestValidatorCheckpointIndex - latestMerkleTreeCheckpointIndex,
  );
  return diff < latestMerkleTreeCheckpointIndex / 100;
};
