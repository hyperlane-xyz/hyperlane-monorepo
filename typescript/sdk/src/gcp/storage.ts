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
  private readonly bucket: string;
  private cache: Record<string, StorageReceipt<any>> | undefined;
  private readonly baseUrl: string;

  static fromBucketUrl(bucketUrl: string): GcpStorageWrapper {
    const match = bucketUrl.match(GCS_BUCKET_REGEX);
    if (!match) throw new Error('Could not parse bucket url');
    return new GcpStorageWrapper({
      // Handle both http and gs:// formats
      bucket: match[1] || match[2],
      caching: true,
    });
  }

  constructor(readonly config: StorageConfig) {
    this.bucket = config.bucket;
    this.baseUrl = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o`;
    if (config.caching) {
      this.cache = {};
    }
  }

  private formatKey(key: string): string {
    return this.config.folder ? `${this.config.folder}/${key}` : key;
  }

  private getCachedObject<T>(key: string): StorageReceipt<T> | undefined {
    return this.cache?.[key];
  }

  private setCachedObject<T>(key: string, value: StorageReceipt<T>): void {
    if (this.cache) {
      this.cache[key] = value;
    }
  }

  private async fetchMetadata(key: string): Promise<any> {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(key)}`);
    const response = await fetch(url.toString());

    if (response.status === 404) return undefined;

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(
        `Failed to fetch object metadata: ${response.statusText}. ${responseText}`,
      );
    }

    return response.json();
  }

  private async fetchContent(key: string): Promise<string> {
    const url = `${this.baseUrl}/${encodeURIComponent(key)}?alt=media`;
    const response = await fetch(url);
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Failed to fetch object content: ${response.statusText}. ${responseText}`,
      );
    }

    return responseText;
  }

  async getObject<T>(key: string): Promise<StorageReceipt<T> | undefined> {
    const formattedKey = this.formatKey(key);
    const cachedObject = this.getCachedObject<T>(formattedKey);
    if (cachedObject) {
      return cachedObject;
    }

    try {
      const metadata = await this.fetchMetadata(formattedKey);
      if (!metadata) return undefined;

      const body = await this.fetchContent(formattedKey);
      const result = {
        data: JSON.parse(body),
        // If no updated date is provided, use the Unix epoch start
        // 0 = Unix epoch start (1970-01-01T00:00:00.000Z)
        modified: new Date(metadata.updated ?? 0),
      };

      this.setCachedObject(formattedKey, result);
      return result;
    } catch (e: any) {
      if (e.status === 404) {
        return undefined;
      }
      throw e;
    }
  }

  url(key: string): string {
    const formattedKey = this.formatKey(key);
    return `https://storage.googleapis.com/${this.bucket}/${formattedKey}`;
  }
}
