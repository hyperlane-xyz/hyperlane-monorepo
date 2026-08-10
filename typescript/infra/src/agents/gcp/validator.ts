import { GcpValidator } from '@hyperlane-xyz/sdk';
import {
  S3Checkpoint,
  S3CheckpointWithId,
  isS3CheckpointWithId,
} from '@hyperlane-xyz/utils';

import {
  CheckpointMetric,
  CheckpointReceipt,
  ComparableValidator,
  compareValidatorCheckpoints,
} from '../aws/validator.js';

const checkpointWithMessageIdKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}_with_id.json`;

/**
 * Extension of GcpValidator that includes checkpoint-comparison utilities,
 * mirroring InfraS3Validator (../aws/validator.js) for GCS-backed validators.
 */
export class InfraGcsValidator
  extends GcpValidator
  implements ComparableValidator
{
  static async fromStorageLocation(
    storageLocation: string,
  ): Promise<InfraGcsValidator> {
    const inner = await GcpValidator.fromStorageLocation(storageLocation);
    return new InfraGcsValidator(inner.validatorConfig, inner.storageConfig);
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
    const gcsObject = await this.storage.getObject<
      S3Checkpoint | S3CheckpointWithId
    >(key);
    if (!gcsObject) {
      return;
    }
    if (isS3CheckpointWithId(gcsObject.data)) {
      return {
        data: {
          checkpoint: gcsObject.data.value.checkpoint,
          messageId: gcsObject.data.value.message_id,
          signature: gcsObject.data.signature,
        },
        modified: gcsObject.modified,
      };
    } else {
      throw new Error('Failed to parse checkpoint');
    }
  }
}
