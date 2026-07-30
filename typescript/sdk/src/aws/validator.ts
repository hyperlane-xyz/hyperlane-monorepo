import {
  Announcement,
  BaseValidator,
  ReorgEvent,
  S3Announcement,
  S3CheckpointWithId,
  ValidatorConfig,
  ValidatorMetadata,
  isS3CheckpointWithId,
} from '@hyperlane-xyz/utils';

import { S3Config, S3Wrapper, validateAnnouncedS3Endpoint } from './s3.js';

const checkpointWithMessageIdKey = (checkpointIndex: number) =>
  `checkpoint_${checkpointIndex}_with_id.json`;
const LATEST_KEY = 'checkpoint_latest_index.json';
const ANNOUNCEMENT_KEY = 'announcement.json';
const METADATA_KEY = 'metadata_latest.json';
const REORG_KEY = 'reorg_flag.json';
export const S3_LOCATION_PREFIX = 's3://';
export const CUSTOM_S3_LOCATION_PREFIX = 's3+custom://';

export function parseS3StorageLocation(
  storageLocation: string,
): S3Config | undefined {
  if (storageLocation.startsWith(S3_LOCATION_PREFIX)) {
    const pieces = storageLocation.slice(S3_LOCATION_PREFIX.length).split('/');
    if (pieces.length < 2) return;
    return {
      bucket: pieces[0],
      region: pieces[1],
      folder: pieces.slice(2).join('/'),
      caching: true,
    };
  }
  if (!storageLocation.startsWith(CUSTOM_S3_LOCATION_PREFIX)) return;

  const suffix = storageLocation.slice(CUSTOM_S3_LOCATION_PREFIX.length);
  const queryIndex = suffix.indexOf('?');
  if (queryIndex === -1) {
    throw new Error(
      `Custom S3 storage location is missing endpoint parameters (${storageLocation})`,
    );
  }
  const pieces = suffix.slice(0, queryIndex).split('/');
  if (pieces.length < 2) return;

  let endpoint: string | undefined;
  let forcePathStyle: boolean | undefined;
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(
    suffix.slice(queryIndex + 1),
  )) {
    if (seen.has(key)) {
      throw new Error(
        `Duplicate S3 storage location parameter ${key} (${storageLocation})`,
      );
    }
    seen.add(key);
    if (key === 'endpoint') {
      validateAnnouncedS3Endpoint(value);
      endpoint = value;
    } else if (key === 'forcePathStyle') {
      if (value !== 'true' && value !== 'false') {
        throw new Error(
          `Invalid forcePathStyle value in S3 storage location (${storageLocation})`,
        );
      }
      forcePathStyle = value === 'true';
    } else {
      throw new Error(
        `Unknown S3 storage location parameter ${key} (${storageLocation})`,
      );
    }
  }

  return {
    bucket: pieces[0],
    region: pieces[1],
    folder: decodeURIComponent(pieces.slice(2).join('/')),
    caching: true,
    endpoint,
    forcePathStyle,
    endpointIsAnnounced: true,
  };
}

function storageLocationFromConfig(config: S3Config): string {
  const custom =
    config.endpoint !== undefined || config.forcePathStyle !== undefined;
  const prefix = custom ? CUSTOM_S3_LOCATION_PREFIX : S3_LOCATION_PREFIX;
  const folder = config.folder
    ? `/${custom ? encodeURIComponent(config.folder) : config.folder}`
    : '';
  const location = `${prefix}${config.bucket}/${config.region}${folder}`;
  if (!custom) return location;

  const query = new URLSearchParams();
  if (config.endpoint !== undefined) query.set('endpoint', config.endpoint);
  if (config.forcePathStyle !== undefined) {
    query.set('forcePathStyle', config.forcePathStyle.toString());
  }
  return `${location}?${query}`;
}

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
    const s3Config = parseS3StorageLocation(storageLocation);
    if (s3Config) {
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
    return storageLocationFromConfig(this.s3Bucket.config);
  }

  getLatestCheckpointUrl(): string {
    return this.s3Bucket.url(LATEST_KEY);
  }

  async getReorgStatus(): Promise<ReorgEvent | null> {
    const resp = await this.s3Bucket.getS3Obj<ReorgEvent>(REORG_KEY);
    if (!resp) {
      return null;
    }

    return resp.data;
  }
}
