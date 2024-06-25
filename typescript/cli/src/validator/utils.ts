import { MerkleTreeHook, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { S3Validator } from '@hyperlane-xyz/sdk';

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

export const getLatestValidatorCheckpointIndex = async (
  s3StorageLocation: string,
): Promise<number | undefined> => {
  let s3Validator: S3Validator;
  try {
    s3Validator = await S3Validator.fromStorageLocation(s3StorageLocation);
    return await s3Validator.getLatestCheckpointIndex();
  } catch (err) {
    logDebug(
      `Failed to get read s3 bucket at location ${s3StorageLocation}: ${err}`,
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
