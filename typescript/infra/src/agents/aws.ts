// @ts-nocheck
import { getSecretAwsCredentials } from '../agents';
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
import { getEthereumAddress } from '../utils/utils';
import { AgentKey } from './agent';

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

export class AgentAwsKey extends AgentKey {
  private environment: string;
  private agentConfig: AgentConfig;
  private client: KMSClient | undefined;
  private region: string;
  public remoteKey: RemoteKey = { fetched: false };

  constructor(
    agentConfig: AgentConfig,
    public readonly role: string,
    public readonly chainName: string,
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
