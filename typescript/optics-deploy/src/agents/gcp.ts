import { Wallet } from 'ethers';
import { rm, writeFile } from 'fs/promises';
import { KEY_ROLES, KEY_ROLE_ENUM } from '../agents';
import { ChainConfig } from '../../src/config/chain';
import { DeployEnvironment } from '../../src/deploy';
import { CoreConfig } from '../../src/config/core';
import { execCmd, include, strip0x } from '../utils';
import { AgentKey } from './agent';

function isAttestationKey(role: string) {
  return role.endsWith('attestation');
}

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

interface KeyAsAddress {
  role: string;
  address: string;
}

function identifier(environment: string, role: string, chainName: string) {
  return isAttestationKey(role)
    ? `optics-key-${environment}-${chainName}-${role}`
    : `optics-key-${environment}-${role}`;
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

export class AgentGCPKey extends AgentKey {
  constructor(
    public readonly environment: string,
    public readonly role: string,
    public readonly chainName: string,
    private remoteKey: RemoteKey = { fetched: false },
  ) {
    super();
  }

  static async create(environment: string, role: string, chainName: string) {
    const key = new AgentGCPKey(environment, role, chainName);
    await key.create();
    return key;
  }

  serializeAsAddress() {
    this.requireFetched();
    return {
      role: isAttestationKey(this.role)
        ? `${this.chainName}-${this.role}`
        : this.role,
      // @ts-ignore
      address: this.remoteKey.address,
    };
  }

  get isAttestationKey() {
    return isAttestationKey(this.role);
  }

  get identifier() {
    return identifier(this.environment, this.role, this.chainName);
  }

  get credentialsAsHelmValue() {
    return {
      hexKey: strip0x(this.privateKey),
    };
  }

  // The identifier for this key within a set of keys for an enrivonment
  get memoryKeyIdentifier() {
    return isAttestationKey(this.role)
      ? `${this.chainName}-${this.role}`
      : this.role;
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

  async fetch() {
    const [secretRaw] = await execCmd(
      `gcloud secrets versions access latest --secret ${this.identifier}`,
    );
    const secret: SecretManagerPersistedKeys = JSON.parse(secretRaw);
    this.remoteKey = {
      fetched: true,
      privateKey: secret.privateKey,
      address: secret.address,
    };
  }

  async create() {
    this.remoteKey = await this._create(false);
  }

  async update() {
    this.remoteKey = await this._create(true);
  }

  async delete() {
    await execCmd(`gcloud secrets delete ${this.identifier} --quiet`);
  }

  private requireFetched() {
    if (!this.remoteKey.fetched) {
      throw new Error("Can't persist without address");
    }
  }

  private async _create(rotate: boolean) {
    const wallet = Wallet.createRandom();
    const address = await wallet.getAddress();
    const identifier = this.identifier;
    const fileName = `${identifier}.txt`;

    let labels = `environment=${this.environment},role=${this.role}`;
    if (this.isAttestationKey) labels += `,chain=${this.chainName}`;

    await writeFile(
      fileName,
      JSON.stringify({
        role: this.role,
        environment: this.environment,
        privateKey: wallet.privateKey,
        address,
        ...include(this.isAttestationKey, { chainName: this.chainName }),
      }),
    );

    if (rotate) {
      await execCmd(
        `gcloud secrets versions add ${identifier} --data-file=${fileName}`,
      );
    } else {
      await execCmd(
        `gcloud secrets create ${identifier} --data-file=${fileName} --replication-policy=automatic --labels=${labels}`,
      );
    }

    await rm(fileName);
    return {
      fetched: true,
      privateKey: wallet.privateKey,
      address,
    };
  }
}

export async function deleteAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  await Promise.all(
    KEY_ROLES.map(async (role) => {
      if (isAttestationKey(role)) {
        await Promise.all(
          chainNames.map((chainName) => {
            const key = new AgentGCPKey(environment, role, chainName);
            return key.delete();
          }),
        );
      } else {
        const key = new AgentGCPKey(environment, role, 'any');
        await key.delete();
      }
    }),
  );
  await execCmd(
    `gcloud secrets delete optics-key-${environment}-addresses --quiet`,
  );
}

// The identifier for a key within a memory representation
export function memoryKeyIdentifier(role: string, chainName: string) {
  return isAttestationKey(role) ? `${chainName}-${role}` : role;
}

export async function createAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  const keys: AgentGCPKey[] = await Promise.all(
    KEY_ROLES.flatMap((role) => {
      if (isAttestationKey(role)) {
        return chainNames.map(async (chainName) =>
          AgentGCPKey.create(environment, role, chainName),
        );
      } else {
        // Chain name doesnt matter for non attestation keys
        return [AgentGCPKey.create(environment, role, 'any')];
      }
    }),
  );

  await persistAddresses(
    environment,
    keys.map((_) => _.serializeAsAddress()),
    true,
  );
}

export async function rotateGCPKey(
  environment: string,
  role: string,
  chainName: string,
) {
  const key = new AgentGCPKey(environment, role, chainName);
  await key.update();
  const addresses = await fetchGCPKeyAddresses(environment);
  const filteredAddresses = addresses.filter((_) => {
    const matchingRole = memoryKeyIdentifier(role, chainName);
    return _.role !== matchingRole;
  });

  filteredAddresses.push(key.serializeAsAddress());
  await persistAddresses(environment, filteredAddresses, false);
}

async function persistAddresses(
  environment: string,
  keys: KeyAsAddress[],
  create = false,
) {
  const addressesIdentifier = `optics-key-${environment}-addresses`;
  const fileName = `${addressesIdentifier}.txt`;
  await writeFile(fileName, JSON.stringify(keys));
  if (create) {
    await execCmd(
      `gcloud secrets create ${addressesIdentifier} --data-file=${fileName} --replication-policy=automatic --labels=environment=${environment}`,
    );
  } else {
    await execCmd(
      `gcloud secrets versions add ${addressesIdentifier} --data-file=${fileName}`,
    );
  }
  await rm(fileName);
}

// This function returns all the GCP keys for a given home chain in a dictionary where the key is either the role or `${chainName}-${role}` in the case of attestation keys
export async function fetchAgentGCPKeys(
  environment: string,
  chainName: string,
): Promise<Record<string, AgentGCPKey>> {
  const secrets = await Promise.all(
    KEY_ROLES.map(async (role) => {
      const key = new AgentGCPKey(environment, role, chainName);
      await key.fetch();
      return [key.memoryKeyIdentifier, key];
    }),
  );
  return Object.fromEntries(secrets);
}

async function fetchGCPKeyAddresses(environment: string) {
  const [addressesRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-addresses`,
  );
  const addresses = JSON.parse(addressesRaw);
  return addresses as KeyAsAddress[];
}

// Modifies a Chain configuration with the deployer key pulled from GCP
export async function addDeployerGCPKey(environment: string, chainConfig: ChainConfig) {
  const key = new AgentGCPKey(environment, KEY_ROLE_ENUM.Deployer, chainConfig.name);
  await key.fetch();
  const deployerSecret = key.privateKey();
  chainConfig.replaceSigner(strip0x(deployerSecret));
  return chainConfig
}

// Modifies a Core configuration with the relevant watcher/updater addresses pulled from GCP
export async function addAgentGCPAddresses(
  environment: DeployEnvironment,
  chainConfig: ChainConfig,
  coreConfig: CoreConfig,
): Promise<CoreConfig> {
  const addresses = await fetchGCPKeyAddresses(environment);
  const watcher = addresses.find(
    (_) => _.role === `${chainConfig.name}-watcher-attestation`,
  )!.address;
  const updater = addresses.find(
    (_) => _.role === `${chainConfig.name}-updater-attestation`,
  )!.address;
  const recoveryManager = addresses.find((_) => _.role === 'deployer')!.address;
  coreConfig.addresses[environment]!.updater = updater;
  coreConfig.addresses[environment]!.recoveryManager = recoveryManager;
  coreConfig.addresses[environment]!.watchers = [watcher];
  return coreConfig
}
