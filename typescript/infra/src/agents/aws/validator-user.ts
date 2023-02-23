import {
  CreateBucketCommand,
  ListBucketsCommand,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts';
import { AgentConfig } from '../../config';
import { KEY_ROLE_ENUM } from '../roles';

import { AgentAwsKey } from './key';
import { AgentAwsUser } from './user';

export class ValidatorAgentAwsUser extends AgentAwsUser {
  private adminS3Client: S3Client;

  constructor(
    environment: string,
    context: Contexts,
    public readonly chainName: ChainName,
    public readonly index: number,
    region: string,
    public readonly bucket: string,
  ) {
    super(environment, context, KEY_ROLE_ENUM.Validator, region, chainName);
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

  key(agentConfig: AgentConfig): AgentAwsKey {
    return new AgentAwsKey(agentConfig, this.role, this.chainName, this.index);
  }

  get tags(): Record<string, string> {
    return {
      ...super.tags,
      index: this.index!.toString(),
    };
  }

  get userName() {
    return `${this.context}-${this.environment}-${this.chainName}-${this.role}-${this.index}`;
  }
}
