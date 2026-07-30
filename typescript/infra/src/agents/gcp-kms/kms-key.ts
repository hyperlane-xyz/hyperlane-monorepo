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

// Cloud KMS asymmetric keys get one version ("1") on first creation; rotation
// would add new versions, but rotation isn't implemented for this key (see
// `update()` below), so this is the only version that ever exists today.
const PRIMARY_KEY_VERSION = '1';

function pemToDer(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return Buffer.from(base64, 'base64');
}

// A Cloud KMS-backed HSM signing key, consolidated per validator index and
// shared across every chain that index signs checkpoints for (deliberately
// not chain-scoped — mirrors the FastPath shared-validator-key identifier
// shape, see `usesSharedValidatorKey` in agent.ts).
//
// Auth to Cloud KMS is entirely ambient (GKE Workload Identity): no static
// credential is ever created or stored for this key. Only the public
// key/address is ever read out of KMS; the private key material never leaves it.
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

  // The CryptoKey resource name — used for the provisioning operations
  // (create/list/IAM-bind) that operate at the key level, not the version level.
  get keyResourceName(): string {
    return `projects/${this.project}/locations/${this.location}/keyRings/${this.keyRingId}/cryptoKeys/${this.keyId}`;
  }

  // The version-qualified resource name. Cloud KMS's GetPublicKey/AsymmetricSign
  // both require a specific CryptoKeyVersion, not just the CryptoKey — this is
  // what the Rust signer actually needs (SignerConf::Gcp { key_version_name }).
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
    this.requireFetched();
    return (this.remoteKey as FetchedKey).address;
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
    this.logger.debug('Checking if key ring/key exist and creating if not');
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

  // Grants a service account permission to sign with (and view the public key
  // of) this specific key — scoped to the key alone, never the key ring or project.
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

  private requireFetched() {
    if (!this.remoteKey.fetched) {
      this.logger.debug('Key has not been fetched yet');
      throw new Error(`Key not fetched: ${this.identifier}`);
    }
  }
}
