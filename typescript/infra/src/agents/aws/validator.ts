import { BaseValidator, types, utils } from '@abacus-network/utils';

import { S3Receipt, S3Wrapper } from './s3';

export enum CheckpointStatus {
  EXTRA = '➕',
  MISSING = '❓',
  INVALID = '❌',
  VALID = '✅',
}

interface CheckpointMetric {
  status: CheckpointStatus;
  delta?: number;
  violation?: string;
}

type CheckpointReceipt = S3Receipt<types.Checkpoint>;

const checkpointKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}.json`;
const LATEST_KEY = 'checkpoint_latest_index.json';

export class S3Validator extends BaseValidator {
  private s3Bucket: S3Wrapper;

  constructor(address: string, localDomain: number, s3Bucket: string) {
    super(address, localDomain);
    this.s3Bucket = new S3Wrapper(s3Bucket);
  }

  async compare(other: S3Validator): Promise<CheckpointMetric[]> {
    const expectedLatest = await other.s3Bucket.getS3Obj<number>(LATEST_KEY);
    const actualLatest = await this.s3Bucket.getS3Obj<number>(LATEST_KEY);

    let actualLatestIndex = actualLatest.data;
    let expectedLatestIndex = expectedLatest.data;

    const maxIndex = Math.max(actualLatestIndex, expectedLatestIndex);
    const checkpointMetrics: CheckpointMetric[] = new Array(maxIndex + 1);

    // scan extra checkpoints
    for (; actualLatestIndex > expectedLatestIndex; actualLatestIndex--) {
      checkpointMetrics[actualLatestIndex] = {
        status: CheckpointStatus.EXTRA,
      };
    }

    // scan missing checkpoints
    for (; expectedLatestIndex > actualLatestIndex; expectedLatestIndex--) {
      checkpointMetrics[expectedLatestIndex] = {
        status: CheckpointStatus.MISSING,
      };
    }

    for (; actualLatestIndex > 0; actualLatestIndex--) {
      let actual: CheckpointReceipt;
      try {
        actual = await this.getCheckpointReceipt(actualLatestIndex);
      } catch (e: any) {
        checkpointMetrics[actualLatestIndex] = {
          status: CheckpointStatus.INVALID,
          violation: e.message,
        };
        continue;
      }

      const expected = await other.getCheckpointReceipt(actualLatestIndex);

      const metric: CheckpointMetric = {
        status: CheckpointStatus.INVALID,
        delta: actual.modified.getSeconds() - expected.modified.getSeconds(),
      };
      if (expected.data.root !== actual.data.root) {
        metric.violation = `root mismatch: ${expected.data.root} != ${actual.data.root}`;
      } else if (expected.data.index !== actual.data.index) {
        metric.violation = `index mismatch: ${expected.data.index} != ${actual.data.index}`;
      } else if (!this.matchesSigner(actual.data)) {
        const signerAddress = this.recoverAddressFromCheckpoint(actual.data);
        metric.violation = `actual signer ${signerAddress} doesn't match validator ${this.address}`;
      } else {
        metric.status = CheckpointStatus.VALID;
      }

      checkpointMetrics[actualLatestIndex] = metric;
    }

    return checkpointMetrics;
  }

  private async getCheckpointReceipt(
    index: number,
  ): Promise<CheckpointReceipt> {
    const key = checkpointKey(index);
    const s3Object = await this.s3Bucket.getS3Obj<types.Checkpoint>(key);
    if (!utils.isCheckpoint(s3Object.data)) {
      throw new Error(`Invalid checkpoint: ${JSON.stringify(s3Object.data)}`);
    }
    return s3Object;
  }
}
