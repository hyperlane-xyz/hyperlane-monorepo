import { BaseValidator, types, utils } from '@abacus-network/utils';

import { S3Receipt, S3Wrapper } from './s3';

enum CheckpointStatus {
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

// TODO: merge with types.Checkpoint
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

export class S3Validator extends BaseValidator {
  private s3Bucket: S3Wrapper;

  constructor(address: string, localDomain: number, s3Bucket: string) {
    super(address, localDomain);
    this.s3Bucket = new S3Wrapper(s3Bucket);
  }

  async compare(other: S3Validator): Promise<CheckpointMetric[]> {
    const expectedLatest = await other.s3Bucket.getS3Obj<number>(LATEST_KEY);
    const actualLatest = await this.s3Bucket.getS3Obj<number>(LATEST_KEY);

    if (!expectedLatest || !actualLatest) {
      throw new Error('Failed to get latest checkpoints');
    }

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
      const expected = await other.getCheckpointReceipt(actualLatestIndex);
      const actual = await this.getCheckpointReceipt(actualLatestIndex);

      const metric: CheckpointMetric = { status: CheckpointStatus.INVALID };
      if (expected && actual) {
        metric.delta =
          actual.modified.getSeconds() - expected.modified.getSeconds();
        if (expected.data.root !== actual.data.root) {
          metric.violation = `root mismatch: expected ${expected.data.root}, received ${actual.data.root}`;
        } else if (expected.data.index !== actual.data.index) {
          metric.violation = `index mismatch: expected ${expected.data.index}, received ${actual.data.index}`;
        }
      }

      if (actual && !this.matchesSigner(actual.data)) {
        const signerAddress = this.recoverAddressFromCheckpoint(actual.data);
        metric.violation = `signer mismatch: expected ${this.address}, received ${signerAddress}`;
      }

      if (!metric.violation) {
        metric.status = CheckpointStatus.VALID;
      }

      checkpointMetrics[actualLatestIndex] = metric;
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
