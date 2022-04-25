import { ChainName } from '@abacus-network/sdk';
import {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { KEY_ROLE_ENUM } from '../../agents';
import { AgentAwsUser } from './user';

export class ValidatorAgentAwsUser<
  Networks extends ChainName,
> extends AgentAwsUser<Networks> {
  private adminS3Client: S3Client;

  constructor(
    environment: string,
    chainName: Networks,
    public readonly index: number,
    region: string,
    public readonly bucket: string,
  ) {
    super(environment, chainName, KEY_ROLE_ENUM.Validator, region);
    this.adminS3Client = new S3Client({ region });
  }

  async createBucketIfNotExists() {
    if (!(await this.bucketExists())) {
      await this.createBucket();
    }
    await this.putBucketAccessPolicy();
  }

  async bucketExists(): Promise<boolean> {
    const cmd = new ListBucketsCommand({});
    const result = await this.adminS3Client.send(cmd);
    return (
      result.Buckets?.find((bucket) => bucket.Name === this.bucket) !==
      undefined
    );
  }

  async createBucket() {
    const cmd = new CreateBucketCommand({
      Bucket: this.bucket,
    });
    await this.adminS3Client.send(cmd);
  }

  async putBucketAccessPolicy() {
    const policy = {
      Statement: [
        // Make the bucket publicly readable
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [
            `arn:aws:s3:::${this.bucket}`,
            `arn:aws:s3:::${this.bucket}/*`,
          ],
        },
        // Allow the user to modify objects
        {
          Effect: 'Allow',
          Principal: {
            AWS: this.arn,
          },
          Action: ['s3:DeleteObject', 's3:PutObject'],
          Resource: `arn:aws:s3:::${this.bucket}/*`,
        },
      ],
    };
    const cmd = new PutBucketPolicyCommand({
      Bucket: this.bucket,
      Policy: JSON.stringify(policy),
    });
    await this.adminS3Client.send(cmd);
  }

  get tags(): Record<string, string> {
    return {
      environment: this.environment,
      role: this.role,
      chain: this.chainName,
      index: this.index!.toString(),
    };
  }

  get userName() {
    return `abacus-${this.environment}-${this.chainName}-${this.role}-${this.index}`;
  }
}
