import { ChainName } from '@abacus-network/sdk';
import { KEY_ROLE_ENUM } from '..';
import { AgentConfig, AwsKeyConfig, KeyType } from '../../config/agent';
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
  PutKeyPolicyCommand,
  UpdateAliasCommand,
} from '@aws-sdk/client-kms';
import { identifier } from '../agent';
import { getEthereumAddress, sleep } from '../../utils/utils';
import { AgentKey } from '../agent';

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

export class AgentAwsKey<Networks extends ChainName> extends AgentKey {
  private environment: string;
  private client: KMSClient | undefined;
  private region: string;
  public remoteKey: RemoteKey = { fetched: false };

  constructor(
    agentConfig: AgentConfig<Networks>,
    public readonly chainName: Networks,
    public readonly role: KEY_ROLE_ENUM,
    public readonly index?: number,
  ) {
    super();
    if (!agentConfig.aws) {
      throw new Error('Not configured as AWS');
    }
    if (role === KEY_ROLE_ENUM.Validator && index === undefined) {
      throw new Error('Expected index for validator key');
    }
    this.environment = agentConfig.environment;
    this.region = agentConfig.aws.region;
  }

  async getClient(): Promise<KMSClient> {
    if (this.client) {
      return this.client;
    }
    this.client = new KMSClient({
      region: this.region,
    });
    return this.client;
  }

  get identifier() {
    return `alias/${identifier(
      this.environment,
      this.role,
      this.chainName,
      this.index,
    )}`;
  }

  get keyConfig(): AwsKeyConfig {
    return {
      type: KeyType.Aws,
      id: this.identifier,
      region: this.region,
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

  async createIfNotExists() {
    let keyId = await this.getId();
    // If it doesn't exist, create it
    if (!keyId) {
      this.create();
      // It can take a moment for the change to propagate
      await sleep(1000);
    }
  }

  // Allows the `userArn` to use the key
  async putKeyPolicy(userArn: string) {
    const client = await this.getClient();
    const policy = {
      Version: '2012-10-17',
      Id: 'key-default-1',
      Statement: [
        {
          Sid: 'Enable IAM User Permissions',
          Effect: 'Allow',
          Principal: {
            AWS: 'arn:aws:iam::625457692493:root',
          },
          Action: 'kms:*',
          Resource: '*',
        },
        {
          Effect: 'Allow',
          Principal: {
            AWS: userArn,
          },
          Action: ['kms:GetPublicKey', 'kms:Sign'],
          Resource: '*',
        },
      ],
    };

    const cmd = new PutKeyPolicyCommand({
      KeyId: await this.getId(),
      Policy: JSON.stringify(policy),
      PolicyName: 'default', // This is the only accepted name
    });
    await client.send(cmd);
  }

  // Gets the Key's ID if it exists, undefined otherwise
  async getId() {
    const client = await this.getClient();
    const listAliasResponse = await client.send(
      new ListAliasesCommand({ Limit: 100 }),
    );
    const match = listAliasResponse.Aliases!.find(
      (_) => _.AliasName === this.identifier,
    );
    return match?.TargetKeyId;
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
        throw new Error(`Couldn't find key ${this.identifier}`);
      }
      keyId = match.TargetKeyId;
    }

    const publicKeyResponse = await client.send(
      new GetPublicKeyCommand({ KeyId: keyId }),
    );

    return getEthereumAddress(Buffer.from(publicKeyResponse.PublicKey!));
  }
}
