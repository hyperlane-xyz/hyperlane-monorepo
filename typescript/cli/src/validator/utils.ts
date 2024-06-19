import { MerkleTreeHook, ValidatorAnnounce } from '@hyperlane-xyz/core';
import { S3Validator } from '@hyperlane-xyz/sdk';

export const getLatestMerkleTreeCheckpointIndex = async (
  merkleTreeHook: MerkleTreeHook,
): Promise<number | undefined> => {
  try {
    const [_, latestCheckpointIndex] = await merkleTreeHook.latestCheckpoint();
    return latestCheckpointIndex;
  } catch (err) {
    // TODO: log debug
    return undefined;
  }
};

export const getValidatorStorageLocations = async (
  validatorAnnounce: ValidatorAnnounce,
  validators: string[],
): Promise<string[][] | undefined> => {
  try {
    return await validatorAnnounce.getAnnouncedStorageLocations(validators);
  } catch (err) {
    // TODO: log debug
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
    // TODO: log debug
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
