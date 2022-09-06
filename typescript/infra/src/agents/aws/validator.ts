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
  index: number;
}

// TODO: merge with types.Checkpoint
/**
 * Shape of a checkpoint in S3 as published by the agent.
 */
interface S3Checkpoint {
  checkpoint: {
    outbox_domain: number;
    root: string;
    index: number;
  };
  signature: {
    r: string;
    s: string;
    v: number;
  };
}

type CheckpointReceipt = S3Receipt<types.Checkpoint>;

const checkpointKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}.json`;
const LATEST_KEY = 'checkpoint_latest_index.json';

/**
 * Extension of BaseValidator that includes AWS S3 utilities.
 */
export class S3Validator extends BaseValidator {
  private s3Bucket: S3Wrapper;

  constructor(address: string, localDomain: number, s3Bucket: string) {
    super(address, localDomain);
    this.s3Bucket = new S3Wrapper(s3Bucket);
  }

  async compare(other: S3Validator): Promise<CheckpointMetric[]> {
    const latestCheckpointIndex = await this.s3Bucket.getS3Obj<number>(
      LATEST_KEY,
    );
    const otherLatestCheckpointIndex = await other.s3Bucket.getS3Obj<number>(
      LATEST_KEY,
    );

    if (!otherLatestCheckpointIndex || !latestCheckpointIndex) {
      throw new Error('Failed to get latest checkpoints');
    }

    let checkpointIndex = latestCheckpointIndex.data;
    let otherCheckpointIndex = otherLatestCheckpointIndex.data;

    const maxIndex = Math.max(checkpointIndex, otherCheckpointIndex);
    const checkpointMetrics: CheckpointMetric[] = new Array(maxIndex + 1);

    // scan extra checkpoints
    for (; checkpointIndex > otherCheckpointIndex; checkpointIndex--) {
      checkpointMetrics[checkpointIndex] = {
        status: CheckpointStatus.EXTRA,
        index: checkpointIndex,
      };
    }

    // scan missing checkpoints
    for (; otherCheckpointIndex > checkpointIndex; otherCheckpointIndex--) {
      checkpointMetrics[otherCheckpointIndex] = {
        status: CheckpointStatus.MISSING,
        index: otherCheckpointIndex,
      };
    }

    for (; checkpointIndex > 0; checkpointIndex--) {
      const expected = await other.getCheckpointReceipt(checkpointIndex);
      const actual = await this.getCheckpointReceipt(checkpointIndex);

      const metric: CheckpointMetric = {
        status: CheckpointStatus.MISSING,
        index: checkpointIndex,
      };

      if (actual) {
        metric.status = CheckpointStatus.VALID;
        if (!this.matchesSigner(actual.data)) {
          const signerAddress = this.recoverAddressFromCheckpoint(actual.data);
          metric.violation = `signer mismatch: expected ${this.address}, received ${signerAddress}`;
        }

        if (expected) {
          metric.delta =
            actual.modified.getSeconds() - expected.modified.getSeconds();
          if (expected.data.root !== actual.data.root) {
            metric.violation = `root mismatch: expected ${expected.data.root}, received ${actual.data.root}`;
          } else if (expected.data.index !== actual.data.index) {
            metric.violation = `index mismatch: expected ${expected.data.index}, received ${actual.data.index}`;
          }
        }

        if (metric.violation) {
          metric.status = CheckpointStatus.INVALID;
        }
      }

      checkpointMetrics[checkpointIndex] = metric;
    }

    return checkpointMetrics;
  }

  private async getCheckpointReceipt(
    index: number,
  ): Promise<CheckpointReceipt | undefined> {
    const key = checkpointKey(index);
    const s3Object = await this.s3Bucket.getS3Obj<S3Checkpoint>(key);
    if (!s3Object) {
      return;
    }
    const checkpoint: types.Checkpoint = {
      signature: s3Object.data.signature,
      ...s3Object.data.checkpoint,
    };
    if (!utils.isCheckpoint(checkpoint)) {
      throw new Error('Failed to parse checkpoint');
    }
    return {
      data: checkpoint,
      modified: s3Object.modified,
    };
  }
}
