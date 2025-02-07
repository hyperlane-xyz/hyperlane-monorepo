import {
  CreateBucketCommand,
  DeletePublicAccessBlockCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  PublicAccessBlockConfiguration,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts.js';
import { AgentContextConfig } from '../../config/agent/agent.js';
import { DeployEnvironment } from '../../config/environment.js';
import { Role } from '../../roles.js';

import { AgentAwsKey } from './key.js';
import { AgentAwsUser } from './user.js';

export class ValidatorAgentAwsUser extends AgentAwsUser {
  private adminS3Client: S3Client;

  constructor(
    environment: DeployEnvironment,
    context: Contexts,
    public readonly chainName: ChainName,
    public readonly index: number,
    region: string,
    public readonly bucket: string,
  ) {
    super(environment, context, Role.Validator, region, chainName);
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
    // First ensure there is no public access block, which
    // will prevent the following put bocket policy command.
    await this.removePublicAccessBlock();

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

  async removePublicAccessBlock() {
    // By default, a public access block is placed on all buckets,
    // which prevents the bucket from being made publicly readable by a bucket access policy.
    // This ensures the block is removed.

    const getCmd = new GetPublicAccessBlockCommand({
      Bucket: this.bucket,
    });
    let accessBlockConfiguration: PublicAccessBlockConfiguration | undefined;
    try {
      const { PublicAccessBlockConfiguration: configuration } =
        await this.adminS3Client.send(getCmd);
      accessBlockConfiguration = configuration;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes('NoSuchPublicAccessBlockConfiguration')
      ) {
        // No public access block exists
        return;
      }
    }
    const blockExists =
      accessBlockConfiguration?.BlockPublicAcls ||
      accessBlockConfiguration?.BlockPublicPolicy ||
      accessBlockConfiguration?.IgnorePublicAcls ||
      accessBlockConfiguration?.RestrictPublicBuckets ||
      false;
    if (blockExists) {
      const deleteCmd = new DeletePublicAccessBlockCommand({
        Bucket: this.bucket,
      });
      await this.adminS3Client.send(deleteCmd);
    }
  }

  key(agentConfig: AgentContextConfig): AgentAwsKey {
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
