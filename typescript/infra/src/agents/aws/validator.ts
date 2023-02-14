import { BaseValidator, types, utils } from '@hyperlane-xyz/utils';

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
  value: {
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
const ANNOUNCEMENT_KEY = 'announcement.json';

/**
 * Extension of BaseValidator that includes AWS S3 utilities.
 */
export class S3Validator extends BaseValidator {
  s3Bucket: S3Wrapper;

  constructor(
    address: string,
    localDomain: number,
    mailbox: string,
    s3Bucket: string,
    s3Region: string,
  ) {
    super(address, localDomain, mailbox);
    this.s3Bucket = new S3Wrapper(s3Bucket, s3Region);
  }

  static async fromStorageLocation(
    storageLocation: string,
  ): Promise<S3Validator> {
    const prefix = 's3://';
    if (storageLocation.startsWith(prefix)) {
      const suffix = storageLocation.slice(prefix.length);
      const pieces = suffix.split('/');
      if (pieces.length == 2) {
        const s3Bucket = new S3Wrapper(pieces[0], pieces[1]);
        const announcement = await s3Bucket.getS3Obj<any>(ANNOUNCEMENT_KEY);
        const address = announcement?.data.value.validator;
        const mailbox = announcement?.data.value.mailbox_address;
        const localDomain = announcement?.data.value.mailbox_domain;
        return new S3Validator(
          address,
          localDomain,
          mailbox,
          pieces[0],
          pieces[1],
        );
      }
    }
    throw new Error(`Unable to parse location ${storageLocation}`);
  }

  async getAnnouncement(): Promise<any> {
    const data = await this.s3Bucket.getS3Obj<any>(ANNOUNCEMENT_KEY);
    if (data) {
      return data.data;
    }
  }

  async getLatestCheckpointIndex() {
    const latestCheckpointIndex = await this.s3Bucket.getS3Obj<number>(
      LATEST_KEY,
    );

    if (!latestCheckpointIndex) return -1;

    return latestCheckpointIndex.data;
  }

  async compare(other: S3Validator, count = 20): Promise<CheckpointMetric[]> {
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

    const stop = Math.max(maxIndex - count, 0);

    for (; checkpointIndex > stop; checkpointIndex--) {
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

    return checkpointMetrics.slice(-1 * count);
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
      // @ts-ignore Old checkpoints might still be in this format
      ...s3Object.data.checkpoint,
      ...s3Object.data.value,
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
