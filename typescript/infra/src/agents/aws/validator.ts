import { S3Receipt, S3Validator } from '@hyperlane-xyz/sdk';
import {
  BaseValidator,
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

export interface CheckpointMetric {
  status: CheckpointStatus;
  delta?: number;
  violation?: string;
  index: number;
}

export interface SignedCheckpoint {
  checkpoint: Checkpoint;
  messageId: HexString;
  signature: SignatureLike;
}

export type CheckpointReceipt = S3Receipt<SignedCheckpoint>;

// Storage-agnostic shape both InfraS3Validator and InfraGcsValidator satisfy,
// so a chain's validator set can be compared across providers during a
// migration (e.g. some validators still on AWS, some already on GCP).
export interface ComparableValidator {
  readonly address: string;
  storageLocation(): string;
  getLatestCheckpointIndex(): Promise<number>;
  getCheckpointReceipt(index: number): Promise<CheckpointReceipt | undefined>;
  matchesSigner(
    checkpoint: Checkpoint,
    signature: SignatureLike,
    messageId: HexString,
  ): boolean;
  compare(
    other: ComparableValidator,
    count?: number,
  ): Promise<CheckpointMetric[]>;
}

const checkpointWithMessageIdKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}_with_id.json`;

/**
 * Extension of BaseValidator that includes AWS S3 utilities.
 */
export class InfraS3Validator
  extends S3Validator
  implements ComparableValidator
{
  static async fromStorageLocation(
    storageLocation: string,
  ): Promise<InfraS3Validator> {
    const inner = await S3Validator.fromStorageLocation(storageLocation);
    return new InfraS3Validator(inner.validatorConfig, inner.s3Config);
  }

  async compare(
    other: ComparableValidator,
    count = 5,
  ): Promise<CheckpointMetric[]> {
    return compareValidatorCheckpoints(this, other, count);
  }

  async getCheckpointReceipt(
    index: number,
  ): Promise<CheckpointReceipt | undefined> {
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

// Shared by InfraS3Validator and InfraGcsValidator (../gcp/validator.js) —
// the comparison logic only depends on the ComparableValidator shape, not on
// which cloud storage backend either side actually reads from.
export async function compareValidatorCheckpoints(
  target: ComparableValidator,
  other: ComparableValidator,
  count = 5,
): Promise<CheckpointMetric[]> {
  const latestCheckpointIndex = await target.getLatestCheckpointIndex();
  const otherLatestCheckpointIndex = await other.getLatestCheckpointIndex();

  // Both backends return -1 (not throw) when no latest-index object exists.
  // The old InfraS3Validator.compare() explicitly failed on a missing latest
  // checkpoint rather than treating an empty store as "0 checkpoints" -
  // preserve that here, or an empty/misconfigured store on either side
  // silently prints a clean comparison table instead of failing the check.
  if (latestCheckpointIndex === -1 || otherLatestCheckpointIndex === -1) {
    throw new Error('Failed to get latest checkpoints');
  }

  let checkpointIndex = latestCheckpointIndex;
  let otherCheckpointIndex = otherLatestCheckpointIndex;

  const maxIndex = Math.max(checkpointIndex, otherCheckpointIndex);
  const checkpointMetrics: CheckpointMetric[] = Array.from({
    length: maxIndex + 1,
  });

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
    const actual = await target.getCheckpointReceipt(checkpointIndex);

    const metric: CheckpointMetric = {
      status: CheckpointStatus.MISSING,
      index: checkpointIndex,
    };

    if (actual) {
      metric.status = CheckpointStatus.VALID;
      if (
        !target.matchesSigner(
          actual.data.checkpoint,
          actual.data.signature,
          actual.data.messageId,
        )
      ) {
        const signerAddress = BaseValidator.recoverAddressFromCheckpoint(
          actual.data.checkpoint,
          actual.data.signature,
          actual.data.messageId,
        );
        metric.violation = `signer mismatch: expected ${target.address}, received ${signerAddress}`;
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
