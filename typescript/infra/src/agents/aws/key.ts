import {
  AliasListEntry,
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  DescribeKeyCommand,
  DescribeKeyCommandOutput,
  GetPublicKeyCommand,
  KMSClient,
  KeySpec,
  KeyUsageType,
  ListAliasesCommand,
  ListAliasesCommandOutput,
  OriginType,
  PutKeyPolicyCommand,
  UpdateAliasCommand,
} from '@aws-sdk/client-kms';
import { KmsEthersSigner } from 'aws-kms-ethers-signer';
import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';

import { AgentContextConfig, AwsKeyConfig, KeyType } from '../../config/agent';
import { Role } from '../../roles';
import { getEthereumAddress, sleep } from '../../utils/utils';
import { keyIdentifier } from '../agent';
import { CloudAgentKey } from '../keys';

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

export class AgentAwsKey extends CloudAgentKey {
  private client: KMSClient | undefined;
  private region: string;
  public remoteKey: RemoteKey = { fetched: false };

  constructor(
    agentConfig: AgentContextConfig,
    role: Role,
    chainName?: ChainName,
    index?: number,
  ) {
    super(agentConfig.runEnv, agentConfig.context, role, chainName, index);
    if (!agentConfig.aws) {
      throw new Error('Not configured as AWS');
    }
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
    return `alias/${keyIdentifier(
      this.environment,
      this.context,
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
    const keyId = await this.getId();
    // If it doesn't exist, create it
    if (!keyId) {
      // TODO should this be awaited? create is async
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.create();
      // It can take a moment for the change to propagate
      await sleep(1000);
    }
    await this.fetch();
  }

  async delete() {
    throw Error('Not implemented yet');
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
          Action: ['kms:GetPublicKey', 'kms:Sign', 'kms:DescribeKey'],
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
    try {
      const keyDescription = await this.describeKey();
      return keyDescription.KeyMetadata?.KeyId;
    } catch (err: any) {
      if (err.name === 'NotFoundException') {
        return undefined;
      }
      throw err;
    }
  }

  create() {
    return this._create(false);
  }

  /**
   * Creates the new key but doesn't actually rotate it
   * @returns The address of the new key
   */
  update() {
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
    const aliases = await this.getAliases();
    const canonicalMatch = aliases.find((_) => _.AliasName === canonicalAlias);
    const newMatch = aliases.find((_) => _.AliasName === newAlias);
    const oldMatch = aliases.find((_) => _.AliasName === oldAlias);
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
    await this.fetch();
  }

  async getSigner(
    provider?: ethers.providers.Provider,
  ): Promise<ethers.Signer> {
    const keyId = await this.getId();
    if (!keyId) {
      throw Error('Key ID not defined');
    }
    // @ts-ignore We're using a newer version of Provider than
    // KmsEthersSigner. The return type for getFeeData for this newer
    // type is a superset of the return type for getFeeData for the older type,
    // which should be fine.
    return new KmsEthersSigner(
      {
        keyId,
        kmsClientConfig: {
          region: this.region,
        },
      },
      provider,
    );
  }

  private requireFetched() {
    if (!this.remoteKey.fetched) {
      throw new Error('Key not fetched');
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
      Description: `${this.environment} ${this.chainName ?? 'omniscient'} ${
        this.role
      }`,
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

    if (!keyId) {
      keyId = await this.getId();
    }

    const publicKeyResponse = await client.send(
      new GetPublicKeyCommand({ KeyId: keyId }),
    );

    return getEthereumAddress(Buffer.from(publicKeyResponse.PublicKey!));
  }

  private async describeKey(): Promise<DescribeKeyCommandOutput> {
    const client = await this.getClient();
    return client.send(
      new DescribeKeyCommand({
        KeyId: this.identifier,
      }),
    );
  }

  private async getAliases(): Promise<AliasListEntry[]> {
    const client = await this.getClient();
    let aliases: AliasListEntry[] = [];
    let marker: string | undefined = undefined;
    // List will output a max of 100 at a time, so we need to use marker
    // to fetch all of them.
    while (true) {
      const listAliasResponse: ListAliasesCommandOutput = await client.send(
        new ListAliasesCommand({
          Limit: 100,
          Marker: marker,
        }),
      );
      if (
        !listAliasResponse.Aliases ||
        listAliasResponse.Aliases.length === 0
      ) {
        break;
      }
      aliases = aliases.concat(listAliasResponse.Aliases);
      if (listAliasResponse.NextMarker) {
        marker = listAliasResponse.NextMarker;
      } else {
        break;
      }
    }
    return aliases;
  }
}
