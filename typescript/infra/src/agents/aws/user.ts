import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  IAMClient,
  ListUsersCommand,
  ListUsersCommandOutput,
  User,
} from '@aws-sdk/client-iam';

import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts.js';
import { AgentContextConfig } from '../../config/agent/agent.js';
import { DeployEnvironment } from '../../config/environment.js';
import { Role } from '../../roles.js';
import {
  fetchGCPSecret,
  gcpSecretExists,
  setGCPSecret,
} from '../../utils/gcloud.js';
import { userIdentifier } from '../agent.js';

import { AgentAwsKey } from './key.js';

export class AgentAwsUser {
  private adminIamClient: IAMClient;

  private _arn: string | undefined;

  constructor(
    public readonly environment: DeployEnvironment,
    public readonly context: Contexts,
    public readonly role: Role,
    public readonly region: string,
    public readonly chainName?: ChainName,
  ) {
    this.adminIamClient = new IAMClient({ region });
  }

  // Creates the AWS user if it doesn't exist.
  // Gets API access keys and saves them in GCP secret manager if they do not already exist.
  // Populates `this._arn` with the ARN of the user.
  async createIfNotExists() {
    const users = await this.getUsers();
    const match = users.find((user) => user.UserName === this.userName);
    if (match) {
      this._arn = match?.Arn;
    } else {
      this._arn = await this.create();
    }
    if (!(await this.accessKeysExist())) {
      await this.createAndSaveAccessKey();
    }
  }

  // Creates the AWS user
  async create() {
    const cmd = new CreateUserCommand({
      UserName: this.userName,
      Tags: this.awsTags,
    });
    const response = await this.adminIamClient.send(cmd);
    if (!response.User) {
      throw Error('Expected User');
    }
    return response.User.Arn;
  }

  async accessKeysExist(): Promise<boolean> {
    const accessKeyIdExists = await gcpSecretExists(this.accessKeyIdSecretName);
    const secretAccessKeyExists = await gcpSecretExists(
      this.secretAccessKeySecretName,
    );
    return accessKeyIdExists && secretAccessKeyExists;
  }

  async getAccessKeys(): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
  }> {
    const accessKeyId = await fetchGCPSecret(this.accessKeyIdSecretName, false);
    if (typeof accessKeyId != 'string')
      throw Error('Expected accessKeyId to be a string');

    const secretAccessKey = await fetchGCPSecret(
      this.secretAccessKeySecretName,
      false,
    );
    if (typeof secretAccessKey != 'string')
      throw Error('Expected secretAccessKey to be a string');

    return { accessKeyId, secretAccessKey };
  }

  async createAndSaveAccessKey(): Promise<void> {
    const cmd = new CreateAccessKeyCommand({
      UserName: this.userName,
    });
    const { AccessKey: accessKey } = await this.adminIamClient.send(cmd);
    if (!accessKey || !accessKey.AccessKeyId || !accessKey.SecretAccessKey) {
      throw Error('Expected fully defined access key');
    }
    await setGCPSecret(
      this.accessKeyIdSecretName,
      accessKey.AccessKeyId,
      this.tags,
    );
    await setGCPSecret(
      this.secretAccessKeySecretName,
      accessKey.SecretAccessKey,
      this.tags,
    );
  }

  key(agentConfig: AgentContextConfig): AgentAwsKey {
    return new AgentAwsKey(agentConfig, this.role, this.chainName);
  }

  async createKeyIfNotExists(
    agentConfig: AgentContextConfig,
  ): Promise<AgentAwsKey> {
    const key = this.key(agentConfig);
    await key.createIfNotExists();
    await key.putKeyPolicy(this.arn);
    return key;
  }

  private async getUsers(): Promise<User[]> {
    let users: User[] = [];
    let marker: string | undefined = undefined;
    // List will output a max of 100 at a time, so we need to use marker
    // to fetch all of them.
    while (true) {
      const listAliasResponse: ListUsersCommandOutput =
        await this.adminIamClient.send(
          new ListUsersCommand({
            Marker: marker,
          }),
        );
      if (!listAliasResponse.Users || listAliasResponse.Users.length === 0) {
        break;
      }

      users = users.concat(listAliasResponse.Users);

      if (listAliasResponse.IsTruncated) {
        marker = listAliasResponse.Marker;
      } else {
        break;
      }
    }
    return users;
  }

  get awsTags() {
    const tags = this.tags;
    return Object.keys(tags).map((key) => ({
      Key: key,
      Value: tags[key],
    }));
  }

  get tags(): Record<string, string> {
    const tags: Record<string, string> = {
      environment: this.environment,
      role: this.role,
    };
    if (this.chainName !== undefined) {
      tags.chain = this.chainName;
    }
    return tags;
  }

  get userName() {
    return userIdentifier(
      this.environment,
      this.context,
      this.role,
      this.chainName,
    );
  }

  get accessKeyIdSecretName() {
    return `${this.userName}-aws-access-key-id`;
  }

  get secretAccessKeySecretName() {
    return `${this.userName}-aws-secret-access-key`;
  }

  get arn(): string {
    if (!this._arn) {
      throw Error('ARN is undefined');
    }
    return this._arn;
  }
}
