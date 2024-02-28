import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

import { streamToString } from '@hyperlane-xyz/utils';

export const S3_BUCKET_REGEX =
  /^(?:https?:\/\/)?(.*)\.s3\.(.*)\.amazonaws.com\/?$/;

export interface S3Receipt<T = unknown> {
  data: T;
  modified: Date;
}

export class S3Wrapper {
  private readonly client: S3Client;
  readonly bucket: string;
  readonly region: string;
  readonly folder: string | undefined;

  static fromBucketUrl(bucketUrl: string): S3Wrapper {
    const match = bucketUrl.match(S3_BUCKET_REGEX);
    if (!match) throw new Error('Could not parse bucket url');
    return new S3Wrapper(match[1], match[2], undefined);
  }

  constructor(bucket: string, region: string, folder: string | undefined) {
    this.bucket = bucket;
    this.region = region;
    this.folder = folder;
    this.client = new S3Client({ region });
  }

  async getS3Obj<T>(key: string): Promise<S3Receipt<T> | undefined> {
    const Key = this.folder ? `${this.folder}/${key}` : key;
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key,
    });
    try {
      const response = await this.client.send(command);
      const body: string = await streamToString(response.Body as Readable);
      return {
        data: JSON.parse(body),
        modified: response.LastModified!,
      };
    } catch (e: any) {
      if (e.message.includes('The specified key does not exist.')) {
        return;
      }
      throw e;
    }
  }
}
