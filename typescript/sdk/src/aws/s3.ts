import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

import { streamToString } from '@hyperlane-xyz/utils';

export const S3_BUCKET_REGEX =
  /^(?:https?:\/\/)?(.*)\.s3\.(.*)\.amazonaws.com\/?$/;

export interface S3Receipt<T = unknown> {
  data: T;
  modified: Date;
}

export interface S3Config {
  bucket: string;
  region: string;
  folder?: string;
  caching?: boolean;
}

export class S3Wrapper {
  private readonly client: S3Client;

  private cache: Record<string, S3Receipt<any>> | undefined;

  static fromBucketUrl(bucketUrl: string): S3Wrapper {
    const match = bucketUrl.match(S3_BUCKET_REGEX);
    if (!match) throw new Error('Could not parse bucket url');
    return new S3Wrapper({
      bucket: match[1],
      region: match[2],
      caching: true,
    });
  }

  constructor(readonly config: S3Config) {
    this.client = new S3Client({
      ...config,
      // explicitly set empty credentials to allow usage without env vars
      credentials: {
        accessKeyId: '',
        secretAccessKey: '',
      },
      signer: { sign: async (req) => req },
    });
    if (config.caching) {
      this.cache = {};
    }
  }

  formatKey(key: string): string {
    return this.config.folder ? `${this.config.folder}/${key}` : key;
  }

  async getS3Obj<T>(key: string): Promise<S3Receipt<T> | undefined> {
    const Key = this.formatKey(key);
    if (this.cache?.[Key]) {
      return this.cache![Key];
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key,
    });
    try {
      const response = await this.client.send(command);
      const body: string = await streamToString(response.Body as Readable);
      const result = {
        data: JSON.parse(body),
        modified: response.LastModified!,
      };
      if (this.cache) {
        this.cache[Key] = result;
      }
      return result;
    } catch (e: any) {
      if (e.message.includes('The specified key does not exist.')) {
        return;
      }
      throw e;
    }
  }

  url(key: string): string {
    const Key = this.formatKey(key);
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${Key}`;
  }
}
