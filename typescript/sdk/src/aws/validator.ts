import {
  Announcement,
  BaseValidator,
  S3Announcement,
  S3CheckpointWithId,
  ValidatorConfig,
  isS3CheckpointWithId,
} from '@hyperlane-xyz/utils';

import {
  HTTP_LOCATION_PREFIX,
  S3Config,
  S3Wrapper,
  S3_LOCATION_PREFIX,
} from './s3.js';

const checkpointWithMessageIdKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}_with_id.json`;
const LATEST_KEY = 'checkpoint_latest_index.json';
const ANNOUNCEMENT_KEY = 'announcement.json';

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
    let s3Bucket: S3Wrapper | undefined;
    if (storageLocation.startsWith(S3_LOCATION_PREFIX)) {
      s3Bucket = S3Wrapper.fromS3FormatLocation(storageLocation);
    }
    if (storageLocation.startsWith(HTTP_LOCATION_PREFIX)) {
      s3Bucket = S3Wrapper.fromBucketUrl(storageLocation);
    }
    if (s3Bucket) {
      return S3Validator.fromS3Bucket(s3Bucket);
    }
    throw new Error(`Unable to parse location ${storageLocation}`);
  }

  static async fromS3Bucket(s3Bucket: S3Wrapper): Promise<S3Validator> {
    const announcement = await s3Bucket.getS3Obj<S3Announcement>(
      ANNOUNCEMENT_KEY,
    );
    if (!announcement) {
      throw new Error('No announcement found');
    }

    const validatorConfig = {
      address: announcement.data.value.validator,
      localDomain: announcement.data.value.mailbox_domain,
      mailbox: announcement.data.value.mailbox_address,
    };

    return new S3Validator(validatorConfig, s3Bucket.config);
  }

  async getAnnouncement(): Promise<Announcement> {
    const { value } = await this.getSignedAnnouncement();
    return value;
  }

  async getSignedAnnouncement(): Promise<S3Announcement> {
    const resp = await this.s3Bucket.getS3Obj<S3Announcement>(ANNOUNCEMENT_KEY);
    if (!resp) {
      throw new Error('No announcement found');
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
    const latestCheckpointIndex = await this.s3Bucket.getS3Obj<number>(
      LATEST_KEY,
    );

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
