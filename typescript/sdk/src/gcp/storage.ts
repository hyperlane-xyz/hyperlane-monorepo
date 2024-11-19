import { Storage } from '@google-cloud/storage';

export const GCS_BUCKET_REGEX =
  /^(?:(?:https?:\/\/)?([^/]+)\.storage\.googleapis\.com\/?|gs:\/\/([^/]+))$/;

export interface StorageReceipt<T = unknown> {
  data: T;
  modified: Date;
}

export interface StorageConfig {
  bucket: string;
  folder?: string;
  caching?: boolean;
  // Optional credentials config
  projectId?: string;
  keyFilename?: string;
}

export class GcpStorageWrapper {
  private readonly client: Storage;
  private readonly bucket: string;
  private cache: Record<string, StorageReceipt<any>> | undefined;

  static fromBucketUrl(bucketUrl: string): GcpStorageWrapper {
    const match = bucketUrl.match(GCS_BUCKET_REGEX);
    if (!match) throw new Error('Could not parse bucket url');
    return new GcpStorageWrapper({
      bucket: match[1],
      caching: true,
    });
  }

  constructor(readonly config: StorageConfig) {
    this.client = new Storage({
      projectId: config.projectId,
      keyFilename: config.keyFilename,
    });
    this.bucket = config.bucket;
    if (config.caching) {
      this.cache = {};
    }
  }

  // List items in the bucket with optional folder prefix
  async listItems(): Promise<string[]> {
    const bucket = this.client.bucket(this.bucket);
    const options = this.config.folder
      ? { prefix: this.config.folder + '/' }
      : {};

    try {
      const [files] = await bucket.getFiles(options);
      return files.map((file) => {
        const fullPath = file.name;
        // If there's a folder prefix, remove it from the returned paths
        return this.config.folder
          ? fullPath.slice(this.config.folder.length + 1)
          : fullPath;
      });
    } catch (e) {
      throw new Error(`Failed to list items in bucket: ${e}`);
    }
  }

  formatKey(key: string): string {
    return this.config.folder ? `${this.config.folder}/${key}` : key;
  }

  async getObject<T>(key: string): Promise<StorageReceipt<T> | undefined> {
    const Key = this.formatKey(key);
    if (this.cache?.[Key]) {
      return this.cache![Key];
    }

    try {
      const bucket = this.client.bucket(this.bucket);
      const file = bucket.file(Key);
      const [exists] = await file.exists();

      if (!exists) {
        return undefined;
      }

      const [metadata] = await file.getMetadata();
      const [contents] = await file.download();
      const body = contents.toString('utf-8');

      const result = {
        data: JSON.parse(body),
        modified: new Date(metadata.updated ?? ''),
      };

      if (this.cache) {
        this.cache[Key] = result;
      }
      return result;
    } catch (e: any) {
      if (e.code === 404) {
        return undefined;
      }
      throw e;
    }
  }

  url(key: string): string {
    const Key = this.formatKey(key);
    return `https://storage.googleapis.com/${this.bucket}/${Key}`;
  }
}
