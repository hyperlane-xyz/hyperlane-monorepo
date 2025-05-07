import {
  Announcement,
  BaseValidator,
  S3Announcement,
  S3CheckpointWithId,
  ValidatorConfig,
  ValidatorMetadata,
  isS3CheckpointWithId,
} from '@hyperlane-xyz/utils';

import { S3Config, S3Wrapper } from './s3.js';

const checkpointWithMessageIdKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}_with_id.json`;
const LATEST_KEY = 'checkpoint_latest_index.json';
const ANNOUNCEMENT_KEY = 'announcement.json';
const METADATA_KEY = 'metadata_latest.json';
export const S3_LOCATION_PREFIX = 's3://';

/**
 * Extension of BaseValidator that includes AWS S3 utilities.
 */
export class S3Validator extends BaseValidator {
  public s3Bucket: S3Wrapper;

  constructor(
    public validatorConfig: ValidatorConfig,
    public s3Config: S3Config,
  ) {
    super(validatorConfig);
    this.s3Bucket = new S3Wrapper(s3Config);
  }

  static async fromStorageLocation(
    storageLocation: string,
  ): Promise<S3Validator> {
    if (storageLocation.startsWith(S3_LOCATION_PREFIX)) {
      const suffix = storageLocation.slice(S3_LOCATION_PREFIX.length);
      const pieces = suffix.split('/');
      if (pieces.length >= 2) {
        const s3Config = {
          bucket: pieces[0],
          region: pieces[1],
          folder: pieces.slice(2).join('/'),
          caching: true,
        };
        const s3Bucket = new S3Wrapper(s3Config);
        const announcement =
          await s3Bucket.getS3Obj<S3Announcement>(ANNOUNCEMENT_KEY);
        if (!announcement) {
          throw new Error('No announcement found');
        }

        const validatorConfig = {
          address: announcement.data.value.validator,
          localDomain: announcement.data.value.mailbox_domain,
          mailbox: announcement.data.value.mailbox_address,
        };

        return new S3Validator(validatorConfig, s3Config);
      }
    }
    throw new Error(`Unable to parse location ${storageLocation}`);
  }

  async getAnnouncement(): Promise<Announcement> {
    const { value } = await this.getSignedAnnouncement();
    return value;
  }

  async getSignedAnnouncement(): Promise<S3Announcement> {
    const resp = await this.s3Bucket.getS3Obj<S3Announcement>(ANNOUNCEMENT_KEY);
    if (!resp) {
      throw new Error(`No announcement found for ${this.config.localDomain}`);
    }

    return resp.data;
  }

  async getMetadata(): Promise<ValidatorMetadata> {
    const resp = await this.s3Bucket.getS3Obj<ValidatorMetadata>(METADATA_KEY);
    if (!resp) {
      throw new Error(`No metadata found for ${this.config.localDomain}`);
    }

    return resp.data;
  }

  async getCheckpoint(index: number): Promise<S3CheckpointWithId | void> {
    const key = checkpointWithMessageIdKey(index);
    const s3Object = await this.s3Bucket.getS3Obj<S3CheckpointWithId>(key);
    if (!s3Object) {
      return;
    }

    if (isS3CheckpointWithId(s3Object.data)) {
      return s3Object.data;
    } else {
      throw new Error('Failed to parse checkpoint');
    }
  }

  async getLatestCheckpointIndex(): Promise<number> {
    const latestCheckpointIndex =
      await this.s3Bucket.getS3Obj<number>(LATEST_KEY);

    if (!latestCheckpointIndex) return -1;

    return latestCheckpointIndex.data;
  }

  storageLocation(): string {
    return `${S3_LOCATION_PREFIX}/${this.s3Bucket.config.bucket}/${this.s3Bucket.config.region}`;
  }

  getLatestCheckpointUrl(): string {
    return this.s3Bucket.url(LATEST_KEY);
  }
}
