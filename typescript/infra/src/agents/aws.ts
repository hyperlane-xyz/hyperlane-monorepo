import { ChainName } from '@abacus-network/sdk';
import { getSecretAwsCredentials, KEY_ROLE_ENUM } from '../agents';
import { AgentConfig } from '../../src/config/agent';
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  GetPublicKeyCommand,
  KeySpec,
  KeyUsageType,
  KMSClient,
  ListAliasesCommand,
  OriginType,
  UpdateAliasCommand,
} from '@aws-sdk/client-kms';
import {
  IAMClient,
  CreateAccessKeyCommand,
  CreateUserCommand,
  ListUsersCommand,
} from '@aws-sdk/client-iam';
import {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { getEthereumAddress } from '../utils/utils';
import { AgentKey } from './agent';
import { gcpSecretExists, setGCPSecret } from '../utils/gcloud';

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

export class ValidatorAgentAwsUser<Networks extends ChainName> {
  private adminIamClient: IAMClient;
  private adminS3Client: S3Client;

  private _arn: string | undefined;

  constructor(
    public readonly environment: string,
    public readonly chainName: Networks,
    public readonly index: number,
    public readonly region: string,
    public readonly bucket: string,
  ) {
    this.adminIamClient = new IAMClient({ region });
    this.adminS3Client = new S3Client({ region });
  }

  // Creates the AWS user if it doesn't exist.
  // Gets API access keys and saves them in GCP secret manager if they do not already exist.
  // Populates `this._arn` with the ARN of the user.
  async createIfNotExists() {
    const cmd = new ListUsersCommand({});
    const result = await this.adminIamClient.send(cmd);
    const match = result.Users?.find((user) => user.UserName === this.userName);
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

  async createAndSaveAccessKey() {
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
      result.Buckets?.find((bucket) => bucket.Name === this.bucket) !== undefined
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

  get awsTags() {
    const tags = this.tags;
    return Object.keys(tags).map((key) => ({
      Key: key,
      Value: tags[key],
    }));
  }

  get tags(): Record<string, string> {
    return {
      environment: this.environment,
      role: this.role,
      chain: this.chainName,
      index: this.index!.toString(),
    };
  }

  get role() {
    return KEY_ROLE_ENUM.Validator;
  }

  get userName() {
    return `abacus-${this.environment}-${this.chainName}-${this.role}-${this.index}`;
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

export class AgentAwsKey<Networks extends ChainName> extends AgentKey {
  private environment: string;
  private agentConfig: AgentConfig<Networks>;
  private client: KMSClient | undefined;
  private region: string;
  public remoteKey: RemoteKey = { fetched: false };

  constructor(
    agentConfig: AgentConfig<Networks>,
    public readonly role: KEY_ROLE_ENUM,
    public readonly chainName: Networks,
  ) {
    super();
    if (!agentConfig.aws) {
      throw new Error('No AWS env vars set');
    }
    this.environment = agentConfig.environment;
    this.agentConfig = agentConfig;
    this.region = agentConfig.aws.region;
  }

  async getClient(): Promise<KMSClient> {
    if (this.client) {
      return this.client;
    }
    const awsCredentials = await getSecretAwsCredentials(this.agentConfig);
    this.client = new KMSClient({
      region: this.region,
      credentials: awsCredentials,
    });
    return this.client;
  }

  get identifier() {
    return `alias/${this.environment}-${this.chainName}-${this.role}`;
  }

  get credentialsAsHelmValue() {
    return {
      aws: {
        keyId: this.identifier,
        region: this.region,
      },
    };
  }

  get address(): string {
    this.requireFetched();
    // @ts-ignore
    return this.remoteKey.address;
  }

  async fetch() {
    const address = await this.fetchAddressFromAws();
    this.remoteKey = {
      fetched: true,
      address,
    };
  }

  async create() {
    this._create(false);
  }

  /**
   * Creates the new key but doesn't acutally rotate it
   * @returns The address of the new key
   */
  async update() {
    return this._create(true);
  }

  /**
   * Requires update to have been called on this key prior
   */
  async rotate() {
    const canonicalAlias = this.identifier;
    const newAlias = canonicalAlias + '-new';
    const oldAlias = canonicalAlias + '-old';

    const client = await this.getClient();

    // Get the key IDs
    const listAliasResponse = await client.send(
      new ListAliasesCommand({ Limit: 100 }),
    );
    const canonicalMatch = listAliasResponse.Aliases!.find(
      (_) => _.AliasName === canonicalAlias,
    );
    const newMatch = listAliasResponse.Aliases!.find(
      (_) => _.AliasName === newAlias,
    );
    const oldMatch = listAliasResponse.Aliases!.find(
      (_) => _.AliasName === oldAlias,
    );
    if (!canonicalMatch || !newMatch) {
      throw new Error(
        `Attempted to rotate keys but one of them does not exist. Old: ${canonicalMatch}, New: ${newMatch}`,
      );
    }

    if (oldMatch) {
      throw new Error(
        `Old alias ${oldAlias} points to a key, please remove manually before proceeding`,
      );
    }

    const oldKeyId = canonicalMatch.TargetKeyId!;
    const newKeyId = newMatch.TargetKeyId!;

    // alias the current with oldAlias
    await client.send(
      new CreateAliasCommand({ TargetKeyId: oldKeyId, AliasName: oldAlias }),
    );

    // alias the newKey with canonicalAlias
    await client.send(
      new UpdateAliasCommand({
        TargetKeyId: newKeyId,
        AliasName: canonicalAlias,
      }),
    );

    // Remove the old alias
    await client.send(new DeleteAliasCommand({ AliasName: newAlias }));

    // Address should have changed now
    this.fetch();
  }

  private requireFetched() {
    if (!this.remoteKey.fetched) {
      throw new Error("Can't persist without address");
    }
  }

  // Creates a new key and returns its address
  private async _create(rotate: boolean) {
    const client = await this.getClient();
    const alias = this.identifier;
    if (!rotate) {
      // Make sure the alias is not currently in use
      const listAliasResponse = await client.send(
        new ListAliasesCommand({ Limit: 100 }),
      );
      const match = listAliasResponse.Aliases!.find(
        (_) => _.AliasName === alias,
      );
      if (match) {
        throw new Error(
          `Attempted to create new key but alias ${alias} already exists`,
        );
      }
    }

    const command = new CreateKeyCommand({
      Description: `${this.environment} ${this.chainName} ${this.role}`,
      KeyUsage: KeyUsageType.SIGN_VERIFY,
      Origin: OriginType.AWS_KMS,
      BypassPolicyLockoutSafetyCheck: false,
      KeySpec: KeySpec.ECC_SECG_P256K1,
      Tags: [{ TagKey: 'environment', TagValue: this.environment }],
    });

    const createResponse = await client.send(command);
    if (!createResponse.KeyMetadata) {
      throw new Error('KeyMetadata was not returned when creating the key');
    }
    const keyId = createResponse.KeyMetadata?.KeyId;

    const newAliasName = rotate ? `${alias}-new` : alias;
    await client.send(
      new CreateAliasCommand({ TargetKeyId: keyId, AliasName: newAliasName }),
    );

    const address = this.fetchAddressFromAws(keyId);
    return address;
  }

  private async fetchAddressFromAws(keyId?: string) {
    const client = await this.getClient();
    const alias = this.identifier;

    if (!keyId) {
      const listAliasResponse = await client.send(
        new ListAliasesCommand({ Limit: 100 }),
      );

      const match = listAliasResponse.Aliases!.find(
        (_) => _.AliasName === alias,
      );

      if (!match || !match.TargetKeyId) {
        throw new Error('Couldnt find key');
      }
      keyId = match.TargetKeyId;
    }

    const publicKeyResponse = await client.send(
      new GetPublicKeyCommand({ KeyId: keyId }),
    );

    return getEthereumAddress(Buffer.from(publicKeyResponse.PublicKey!));
  }
}
