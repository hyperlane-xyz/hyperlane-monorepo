import { ethers } from 'ethers';
import { Logger } from 'pino';
import { Provider as ZkProvider, Wallet as ZkWallet } from 'zksync-ethers';

import { AgentSignerKeyType } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import type {
  AgentContextConfig,
  GcpKeyConfig,
} from '../../config/agent/agent.js';
import { Role } from '../../roles.js';
import {
  createKmsKeyRingIfNotExists,
  createKmsSignerKeyIfNotExists,
  getKmsPublicKeyPem,
  grantKmsKeySignerRoleIfNotExists,
} from '../../utils/gcloud.js';
import { getEthereumAddress } from '../../utils/utils.js';
import { CloudAgentKey } from '../keys.js';

interface UnfetchedKey {
  fetched: false;
}

interface FetchedKey {
  fetched: true;
  address: string;
}

type RemoteKey = UnfetchedKey | FetchedKey;

// Cloud KMS keys start at version 1; rotation (which would add more) isn't
// implemented (see `update()` below).
const PRIMARY_KEY_VERSION = '1';

const createIfNotExistsPromises = new Map<string, Promise<void>>();

function pemToDer(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(base64, 'base64');
}

// A Cloud KMS-backed HSM signing key, consolidated per validator index and
// shared across every chain that index signs for (not chain-scoped — mirrors
// `usesSharedValidatorKey`'s FastPath identifier shape in agent.ts). Auth is
// ambient (Workload Identity); private key material never leaves KMS.
export class AgentGcpKmsKey extends CloudAgentKey {
  private readonly project: string;
  private readonly location: string;
  private readonly keyRingId: string;
  private readonly keyId: string;
  public remoteKey: RemoteKey = { fetched: false };
  protected logger: Logger;

  constructor(agentConfig: AgentContextConfig, role: Role, index: number) {
    super(agentConfig.runEnv, agentConfig.context, role, undefined, index);
    if (!agentConfig.gcp) {
      throw new Error('Not configured for GCP KMS');
    }
    this.project = agentConfig.gcp.project;
    this.location = agentConfig.gcp.location;
    this.keyRingId = `${agentConfig.context}-${agentConfig.runEnv}-validator-keys`;
    this.keyId = `validator-${index}`;
    this.logger = rootLogger.child({
      module: `infra:agents:key:gcp-kms:${this.identifier}`,
    });
  }

  get identifier() {
    return `${this.context}-${this.environment}-key-${this.role}-${this.index}`;
  }

  // Key-level resource name, for provisioning ops (create/list/IAM-bind).
  get keyResourceName(): string {
    return `projects/${this.project}/locations/${this.location}/keyRings/${this.keyRingId}/cryptoKeys/${this.keyId}`;
  }

  // GetPublicKey/AsymmetricSign need a specific CryptoKeyVersion, not just the
  // CryptoKey — this is what the Rust signer reads (SignerConf::Gcp).
  get keyVersionResourceName(): string {
    return `${this.keyResourceName}/cryptoKeyVersions/${PRIMARY_KEY_VERSION}`;
  }

  get keyConfig(): GcpKeyConfig {
    return {
      type: AgentSignerKeyType.Gcp,
      keyVersionName: this.keyVersionResourceName,
    };
  }

  get address(): string {
    return this.requireFetched().address;
  }

  get privateKey(): string {
    this.logger.debug(
      'Attempting to access private key, which is unavailable for GCP KMS keys',
    );
    throw new Error('Private key unavailable for GCP KMS keys');
  }

  async fetch() {
    this.logger.debug('Fetching address from GCP KMS');
    const address = await this.fetchAddressFromGcp();
    this.remoteKey = { fetched: true, address };
    this.logger.debug(`Address fetched: ${address}`);
  }

  async createIfNotExists() {
    const existing = createIfNotExistsPromises.get(this.keyResourceName);
    if (existing) {
      await existing;
      await this.fetch();
      return;
    }

    const promise = this.createAndFetch();
    createIfNotExistsPromises.set(this.keyResourceName, promise);
    await promise;
  }

  private async createAndFetch() {
    this.logger.debug('Checking if key ring/key exist and creating if not');
    try {
      await createKmsKeyRingIfNotExists(
        this.project,
        this.location,
        this.keyRingId,
      );
      await createKmsSignerKeyIfNotExists(
        this.project,
        this.location,
        this.keyRingId,
        this.keyId,
      );
      await this.fetch();
    } catch (error) {
      createIfNotExistsPromises.delete(this.keyResourceName);
      throw error;
    }
  }

  async exists(): Promise<boolean> {
    try {
      await this.fetch();
      return true;
    } catch {
      return false;
    }
  }

  async delete() {
    throw new Error(
      'Not implemented: Cloud KMS key rings/keys are not deletable via this tooling, only manually',
    );
  }

  // Scoped to this key alone, never the key ring or project.
  async grantSignerRole(serviceAccountEmail: string) {
    await grantKmsKeySignerRoleIfNotExists(
      this.project,
      this.location,
      this.keyRingId,
      this.keyId,
      serviceAccountEmail,
    );
  }

  async update(): Promise<string> {
    throw new Error(
      'Key rotation is not implemented yet for GCP KMS keys (Cloud KMS versions, not aliases, would need a different rotation scheme than the AWS key)',
    );
  }

  async getSigner(
    _provider: ethers.providers.Provider | ZkProvider,
  ): Promise<ethers.Signer | ZkWallet> {
    throw new Error(
      'TS-side signing via Cloud KMS is not implemented; this key is only usable by the Rust validator agent',
    );
  }

  private async fetchAddressFromGcp(): Promise<string> {
    const pem = await getKmsPublicKeyPem(
      this.project,
      this.location,
      this.keyRingId,
      this.keyId,
      PRIMARY_KEY_VERSION,
    );
    return getEthereumAddress(pemToDer(pem));
  }

  private requireFetched(): FetchedKey {
    if (!this.remoteKey.fetched) {
      this.logger.debug('Key has not been fetched yet');
      throw new Error(`Key not fetched: ${this.identifier}`);
    }
    return this.remoteKey;
  }
}
