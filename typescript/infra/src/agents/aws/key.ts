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
import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import { AgentSignerKeyType, ChainName } from '@hyperlane-xyz/sdk';

import { AgentContextConfig, AwsKeyConfig } from '../../config/agent';
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
  protected logger: Debugger;

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
    this.logger = debug(`infra:agents:key:aws:${this.identifier}`);
  }

  get privateKey(): string {
    this.logger(
      'Attempt to access private key, which is unavailable for AWS keys',
    );
    throw new Error('Private key unavailable for AWS keys');
  }

  async getClient(): Promise<KMSClient> {
    if (this.client) {
      this.logger('Returning existing KMSClient instance');
      return this.client;
    }
    this.logger('Creating new KMSClient instance');
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
      type: AgentSignerKeyType.Aws, // Ensure this is the specific enum value expected
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
    this.logger('Fetching key');
    const address = await this.fetchAddressFromAws();
    this.remoteKey = {
      fetched: true,
      address,
    };
  }

  async createIfNotExists() {
    this.logger('Checking if key exists and creating if not');
    const keyId = await this.getId();
    // If it doesn't exist, create it
    if (!keyId) {
      this.logger('Key does not exist, creating new key');
      await this.create();
      // It can take a moment for the change to propagate
      await sleep(1000);
    } else {
      this.logger('Key already exists');
    }
    await this.fetch();
  }

  async delete() {
    this.logger('Delete operation called, but not implemented');
    throw Error('Not implemented yet');
  }

  // Allows the `userArn` to use the key
  async putKeyPolicy(userArn: string) {
    this.logger(`Putting key policy for user ARN: ${userArn}`);
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
    this.logger('Key policy put successfully');
  }

  // Gets the Key's ID if it exists, undefined otherwise
  async getId() {
    try {
      this.logger('Attempting to describe key to get ID');
      const keyDescription = await this.describeKey();
      const keyId = keyDescription.KeyMetadata?.KeyId;
      this.logger(`Key ID retrieved: ${keyId}`);
      return keyId;
    } catch (err: any) {
      if (err.name === 'NotFoundException') {
        this.logger('Key not found');
        return undefined;
      }
      this.logger(`Error retrieving key ID: ${err}`);
      throw err;
    }
  }

  create() {
    this.logger('Creating new key');
    return this._create(false);
  }

  /**
   * Creates the new key but doesn't actually rotate it
   * @returns The address of the new key
   */
  update() {
    this.logger('Updating key (creating new key for rotation)');
    return this._create(true);
  }

  /**
   * Requires update to have been called on this key prior
   */
  async rotate() {
    this.logger('Rotating keys');
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
    this.logger('Keys rotated successfully');
  }

  async getSigner(
    provider?: ethers.providers.Provider,
  ): Promise<ethers.Signer> {
    this.logger('Getting signer');
    const keyId = await this.getId();
    if (!keyId) {
      this.logger('Key ID not defined, cannot get signer');
      throw Error('Key ID not defined');
    }
    this.logger(`Creating KmsEthersSigner with key ID: ${keyId}`);
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
      this.logger('Key has not been fetched yet');
      throw new Error('Key not fetched');
    }
    this.logger('Key has been fetched');
  }

  // Creates a new key and returns its address
  private async _create(rotate: boolean) {
    this.logger(`Creating key with rotation: ${rotate}`);
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
        this.logger(`Alias ${alias} already exists`);
        throw new Error(
          `Attempted to create new key but alias ${alias} already exists`,
        );
      }
    }

    const command = new CreateKeyCommand({
      Description: `${this.context} ${this.environment} ${
        this.chainName ?? 'omniscient'
      } ${this.role}`,
      KeyUsage: KeyUsageType.SIGN_VERIFY,
      Origin: OriginType.AWS_KMS,
      BypassPolicyLockoutSafetyCheck: false,
      KeySpec: KeySpec.ECC_SECG_P256K1,
      Tags: [{ TagKey: 'environment', TagValue: this.environment }],
    });

    const createResponse = await client.send(command);
    if (!createResponse.KeyMetadata) {
      this.logger('KeyMetadata was not returned when creating the key');
      throw new Error('KeyMetadata was not returned when creating the key');
    }
    const keyId = createResponse.KeyMetadata?.KeyId;

    const newAliasName = rotate ? `${alias}-new` : alias;
    await client.send(
      new CreateAliasCommand({ TargetKeyId: keyId, AliasName: newAliasName }),
    );

    const address = this.fetchAddressFromAws(keyId);
    this.logger(`New key created with ID: ${keyId}`);
    return address;
  }

  private async fetchAddressFromAws(keyId?: string) {
    this.logger(`Fetching address from AWS for key ID: ${keyId}`);
    const client = await this.getClient();

    if (!keyId) {
      keyId = await this.getId();
    }

    const publicKeyResponse = await client.send(
      new GetPublicKeyCommand({ KeyId: keyId }),
    );

    const address = getEthereumAddress(
      Buffer.from(publicKeyResponse.PublicKey!),
    );
    this.logger(`Address fetched: ${address}`);
    return address;
  }

  private async describeKey(): Promise<DescribeKeyCommandOutput> {
    this.logger('Describing key');
    const client = await this.getClient();
    return client.send(
      new DescribeKeyCommand({
        KeyId: this.identifier,
      }),
    );
  }

  private async getAliases(): Promise<AliasListEntry[]> {
    this.logger('Getting aliases');
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
    this.logger(`Aliases retrieved: ${aliases.length}`);
    return aliases;
  }
}
