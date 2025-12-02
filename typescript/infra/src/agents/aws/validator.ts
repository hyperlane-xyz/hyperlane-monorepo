import { S3Receipt, S3Validator } from '@hyperlane-xyz/sdk';
import {
  Checkpoint,
  HexString,
  S3Checkpoint,
  S3CheckpointWithId,
  SignatureLike,
  isS3CheckpointWithId,
} from '@hyperlane-xyz/utils';

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

interface SignedCheckpoint {
  checkpoint: Checkpoint;
  messageId: HexString;
  signature: SignatureLike;
}

type S3CheckpointReceipt = S3Receipt<SignedCheckpoint>;

const checkpointWithMessageIdKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}_with_id.json`;
const LATEST_KEY = 'checkpoint_latest_index.json';

/**
 * Extension of BaseValidator that includes AWS S3 utilities.
 */
export class InfraS3Validator extends S3Validator {
  static async fromStorageLocation(
    storageLocation: string,
  ): Promise<InfraS3Validator> {
    const inner = await S3Validator.fromStorageLocation(storageLocation);
    return new InfraS3Validator(inner.validatorConfig, inner.s3Config);
  }

  async compare(
    other: InfraS3Validator,
    count = 5,
  ): Promise<CheckpointMetric[]> {
    const latestCheckpointIndex =
      await this.s3Bucket.getS3Obj<number>(LATEST_KEY);
    const otherLatestCheckpointIndex =
      await other.s3Bucket.getS3Obj<number>(LATEST_KEY);

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
        if (
          !this.matchesSigner(
            actual.data.checkpoint,
            actual.data.signature,
            actual.data.messageId,
          )
        ) {
          const signerAddress = InfraS3Validator.recoverAddressFromCheckpoint(
            actual.data.checkpoint,
            actual.data.signature,
            actual.data.messageId,
          );
          metric.violation = `signer mismatch: expected ${this.address}, received ${signerAddress}`;
        }

        if (expected) {
          metric.delta =
            actual.modified.getSeconds() - expected.modified.getSeconds();
          if (expected.data.checkpoint.root !== actual.data.checkpoint.root) {
            metric.violation = `root mismatch: expected ${expected.data.checkpoint.root}, received ${actual.data.checkpoint.root}`;
          } else if (
            expected.data.checkpoint.index !== actual.data.checkpoint.index
          ) {
            metric.violation = `index mismatch: expected ${expected.data.checkpoint.index}, received ${actual.data.checkpoint.index}`;
          } else if (
            expected.data.checkpoint.merkle_tree_hook_address !==
            actual.data.checkpoint.merkle_tree_hook_address
          ) {
            metric.violation = `mailbox address mismatch: expected ${expected.data.checkpoint.merkle_tree_hook_address}, received ${actual.data.checkpoint.merkle_tree_hook_address}`;
          } else if (
            expected.data.checkpoint.mailbox_domain !==
            actual.data.checkpoint.mailbox_domain
          ) {
            metric.violation = `mailbox domain mismatch: expected ${expected.data.checkpoint.mailbox_domain}, received ${actual.data.checkpoint.mailbox_domain}`;
          } else if (expected.data.messageId !== actual.data.messageId) {
            metric.violation = `message id mismatch: expected ${expected.data.messageId}, received ${actual.data.messageId}`;
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
  ): Promise<S3CheckpointReceipt | undefined> {
    const key = checkpointWithMessageIdKey(index);
    const s3Object = await this.s3Bucket.getS3Obj<
      S3Checkpoint | S3CheckpointWithId
    >(key);
    if (!s3Object) {
      return;
    }
    if (isS3CheckpointWithId(s3Object.data)) {
      return {
        data: {
          checkpoint: s3Object.data.value.checkpoint,
          messageId: s3Object.data.value.message_id,
          signature: s3Object.data.signature,
        },
        modified: s3Object.modified,
      };
    } else {
      throw new Error('Failed to parse checkpoint');
    }
  }
}
