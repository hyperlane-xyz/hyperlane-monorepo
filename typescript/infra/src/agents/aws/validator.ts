import { ethers } from 'ethers';

import { BaseValidator, types, utils } from '@abacus-network/utils';

import { S3Receipt, S3Wrapper } from './s3';

interface CheckpointStats {
  // accumulators for stats
  /** Checkpoints the prospective validator has that the control validator does not */
  extra: number[];
  /** Checkpoints the prospective validator does not have that the control validator does have */
  missing: number[];
  /** Checkpoints the prospective validator has but for which we detected an issue */
  invalid: number[];
  /** The checkpoints which were, as far as this validation logic is concerned, present and valid */
  valid: number[];
  /** The difference in modification times on the s3 objects between the control and validator
   * buckets. (validator time - control time).
   */
  modifiedDeltas: Record<number, number>;
}

type CheckpointReceipt = S3Receipt<types.Checkpoint>;

type S3CheckpointIndex = number | 'latest';
const checkpointKey = (checkpointIndex: S3CheckpointIndex) =>
  `checkpoint_${checkpointIndex}.json`;

export class S3Validator extends BaseValidator {
  private s3Bucket: S3Wrapper;

  constructor(address: string, localDomain: number, s3Bucket: string) {
    super(address, localDomain);
    this.s3Bucket = new S3Wrapper(s3Bucket);
  }

  async compare(other: S3Validator): Promise<CheckpointStats> {
    const stats: CheckpointStats = {
      extra: [],
      missing: [],
      invalid: [],
      valid: [],
      modifiedDeltas: {},
    };

    const expectedLatest = await other.getCheckpointReceipt('latest');
    const actualLatest = await this.getCheckpointReceipt('latest');

    let actualLatestIndex = actualLatest.data.index;
    let expectedLatestIndex = expectedLatest.data.index;

    while (actualLatestIndex > expectedLatestIndex) {
      stats.extra.push(actualLatestIndex);
      actualLatestIndex--;
    }

    while (expectedLatestIndex > actualLatestIndex) {
      stats.missing.push(expectedLatestIndex);
      expectedLatestIndex--;
    }

    for (; actualLatestIndex > 0; actualLatestIndex--) {
      const expected = await other.getCheckpointReceipt(actualLatestIndex);
      let actual: CheckpointReceipt;
      try {
        actual = await this.getCheckpointReceipt(actualLatestIndex);
      } catch (e) {
        stats.missing.push(actualLatestIndex);
        continue;
      }

      if (
        expected.data.root !== actual.data.root ||
        expected.data.index !== actual.data.index
      ) {
        stats.invalid.push(actualLatestIndex);
      } else {
        stats.valid.push(actualLatestIndex);
      }

      stats.modifiedDeltas[actualLatestIndex] =
        actual.modified.getSeconds() - expected.modified.getSeconds();
    }

    return stats;
  }

  private async getCheckpointReceipt(
    index: S3CheckpointIndex,
  ): Promise<CheckpointReceipt> {
    const key = checkpointKey(index);
    const s3Object = await this.s3Bucket.getS3Obj<types.Checkpoint>(key);
    if (!utils.isCheckpoint(s3Object.data)) {
      throw new Error(`Invalid checkpoint: ${JSON.stringify(s3Object.data)}`);
    }
    return s3Object;
  }
}
