import {
  Announcement,
  BaseValidator,
  S3Announcement,
  S3CheckpointWithId,
  isS3CheckpointWithId,
} from '@hyperlane-xyz/utils';

import { S3Wrapper } from './s3.js';

const checkpointWithMessageIdKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}_with_id.json`;
const LATEST_KEY = 'checkpoint_latest_index.json';
const ANNOUNCEMENT_KEY = 'announcement.json';
const LOCATION_PREFIX = 's3://';

/**
 * Extension of BaseValidator that includes AWS S3 utilities.
 */
export class S3Validator extends BaseValidator {
  public s3Bucket: S3Wrapper;

  constructor(
    address: string,
    localDomain: number,
    mailbox: string,
    s3Bucket: string,
    s3Region: string,
    s3Folder: string | undefined,
  ) {
    super(address, localDomain, mailbox);
    this.s3Bucket = new S3Wrapper(s3Bucket, s3Region, s3Folder, true); // caching enabled
  }

  static async fromStorageLocation(
    storageLocation: string,
  ): Promise<S3Validator> {
    if (storageLocation.startsWith(LOCATION_PREFIX)) {
      const suffix = storageLocation.slice(LOCATION_PREFIX.length);
      const pieces = suffix.split('/');
      if (pieces.length >= 2) {
        const s3Bucket = new S3Wrapper(pieces[0], pieces[1], pieces[2]);
        const announcement = await s3Bucket.getS3Obj<S3Announcement>(
          ANNOUNCEMENT_KEY,
        );
        if (!announcement) {
          throw new Error('No announcement found');
        }

        const address = announcement.data.value.validator;
        const mailbox = announcement.data.value.mailbox_address;
        const localDomain = announcement.data.value.mailbox_domain;

        return new S3Validator(
          address,
          localDomain,
          mailbox,
          pieces[0],
          pieces[1],
          pieces[2],
        );
      }
    }
    throw new Error(`Unable to parse location ${storageLocation}`);
  }

  async getAnnouncement(): Promise<Announcement> {
    const resp = await this.s3Bucket.getS3Obj<S3Announcement>(ANNOUNCEMENT_KEY);
    if (!resp) {
      throw new Error('No announcement found');
    }

    return resp.data.value;
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
    return `${LOCATION_PREFIX}/${this.s3Bucket.bucket}/${this.s3Bucket.region}`;
  }
}
