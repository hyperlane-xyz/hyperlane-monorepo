import { encodeSecp256k1Pubkey, pubkeyToAddress } from '@cosmjs/amino';
import { Keypair } from '@solana/web3.js';
import { Debugger, debug } from 'debug';
import { Wallet, ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType, strip0x } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { DeployEnvironment } from '../config';
import { Role } from '../roles';
import { fetchGCPSecret, setGCPSecret } from '../utils/gcloud';
import { execCmd, include } from '../utils/utils';

import { isValidatorKey, keyIdentifier } from './agent';
import { CloudAgentKey } from './keys';

// This is the type for how the keys are persisted in GCP
export interface SecretManagerPersistedKeys {
  privateKey: string;
  address: string;
  role: string;
  environment: string;
  // Exists if key is an attestation key
  // TODO: Add this to the type
  chainName?: string;
}

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  privateKey: string;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

export class AgentGCPKey extends CloudAgentKey {
  protected logger: Debugger;

  constructor(
    environment: DeployEnvironment,
    context: Contexts,
    role: Role,
    chainName?: ChainName,
    index?: number,
    private remoteKey: RemoteKey = { fetched: false },
  ) {
    super(environment, context, role, chainName, index);
    this.logger = debug(`infra:agents:key:gcp:${this.identifier}`);
  }

  async createIfNotExists() {
    this.logger('Checking if key exists and creating if not');
    try {
      await this.fetch();
      this.logger('Key already exists');
    } catch (err) {
      this.logger('Key does not exist, creating new key');
      await this.create();
    }
  }

  serializeAsAddress() {
    this.requireFetched();
    this.logger('Serializing key as address');
    return {
      identifier: this.identifier,
      // @ts-ignore
      address: this.remoteKey.address,
    };
  }

  get isValidatorKey() {
    return isValidatorKey(this.role);
  }

  get identifier() {
    return keyIdentifier(
      this.environment,
      this.context,
      this.role,
      this.chainName,
      this.index,
    );
  }

  get privateKey() {
    this.requireFetched();
    // @ts-ignore
    return this.remoteKey.privateKey;
  }

  get address() {
    this.requireFetched();
    // @ts-ignore
    return this.remoteKey.address;
  }

  addressForProtocol(protocol: ProtocolType): string | undefined {
    this.requireFetched();
    this.logger(`Getting address for protocol: ${protocol}`);

    switch (protocol) {
      case ProtocolType.Ethereum:
        return this.address;
      case ProtocolType.Sealevel:
        return Keypair.fromSeed(
          Buffer.from(strip0x(this.privateKey), 'hex'),
        ).publicKey.toBase58();
      case ProtocolType.Cosmos: {
        const compressedPubkey = ethers.utils.computePublicKey(
          this.privateKey,
          true,
        );
        const encodedPubkey = encodeSecp256k1Pubkey(
          new Uint8Array(Buffer.from(strip0x(compressedPubkey), 'hex')),
        );
        // TODO support other prefixes?
        // https://cosmosdrops.io/en/tools/bech32-converter is useful for converting to other prefixes.
        return pubkeyToAddress(encodedPubkey, 'neutron');
      }
      default:
        this.logger(`Unsupported protocol: ${protocol}`);
        return undefined;
    }
  }

  async fetch() {
    this.logger('Fetching key');
    const secret: SecretManagerPersistedKeys = (await fetchGCPSecret(
      this.identifier,
    )) as any;
    this.remoteKey = {
      fetched: true,
      privateKey: secret.privateKey,
      address: secret.address,
    };
    this.logger(`Key fetched successfully: ${secret.address}`);
  }

  async create() {
    this.logger('Creating new key');
    this.remoteKey = await this._create(false);
    this.logger('Key created successfully');
  }

  async update() {
    this.logger('Updating key');
    this.remoteKey = await this._create(true);
    this.logger('Key updated successfully');
    return this.address;
  }

  async delete() {
    this.logger('Deleting key');
    await execCmd(`gcloud secrets delete ${this.identifier} --quiet`);
    this.logger('Key deleted successfully');
  }

  async getSigner(
    provider?: ethers.providers.Provider,
  ): Promise<ethers.Signer> {
    this.logger('Getting signer');
    if (!this.remoteKey.fetched) {
      this.logger('Key not fetched, fetching now');
      await this.fetch();
    }
    return new Wallet(this.privateKey, provider);
  }

  private requireFetched() {
    if (!this.remoteKey.fetched) {
      this.logger('Key not fetched, throwing error');
      throw new Error("Can't persist without address");
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _create(rotate: boolean) {
    this.logger(`Creating key with rotation: ${rotate}`);
    const wallet = Wallet.createRandom();
    const address = await wallet.getAddress();
    const identifier = this.identifier;

    await setGCPSecret(
      identifier,
      JSON.stringify({
        role: this.role,
        environment: this.environment,
        context: this.context,
        privateKey: wallet.privateKey,
        address,
        ...include(this.isValidatorKey, { chainName: this.chainName }),
      }),
      {
        environment: this.environment,
        context: this.context,
        role: this.role,
        ...include(this.isValidatorKey, {
          chain: this.chainName,
          index: this.index,
        }),
      },
    );
    this.logger('Key creation data persisted to GCP');

    return {
      fetched: true,
      privateKey: wallet.privateKey,
      address,
    };
  }
}
