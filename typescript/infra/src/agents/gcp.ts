import { Wallet } from 'ethers';
import { rm, writeFile } from 'fs/promises';

import { KEY_ROLES, KEY_ROLE_ENUM } from '../agents';
import { execCmd, include, strip0x } from '../utils/utils';
import { AgentKey } from './agent';
import { fetchGCPSecret } from '../utils/gcloud';

function isValidatorKey(role: string) {
  return role === KEY_ROLE_ENUM.Validator;
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

function identifier(
  environment: string,
  role: string,
  chainName: string,
  index: number | undefined,
) {
  return isValidatorKey(role)
    ? `abacus-${environment}-key-${chainName}-${role}-${index}`
    : `abacus-${environment}-key-${role}`;
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
    public readonly index?: number,
    private remoteKey: RemoteKey = { fetched: false },
  ) {
    super();
    if (this.isValidatorKey && index === undefined) {
      throw Error(
        `Expected index to be defined for key with environment ${environment}, role ${role}, and chainName ${chainName}`,
      );
    }
  }

  static async create(
    environment: string,
    role: string,
    chainName: string,
    index?: number,
  ) {
    const key = new AgentGCPKey(environment, role, chainName, index);
    await key.create();
    return key;
  }

  serializeAsAddress() {
    this.requireFetched();
    return {
      role: this.memoryKeyIdentifier,
      // @ts-ignore
      address: this.remoteKey.address,
    };
  }

  get isValidatorKey() {
    return isValidatorKey(this.role);
  }

  get identifier() {
    return identifier(this.environment, this.role, this.chainName, this.index);
  }

  get credentialsAsHelmValue() {
    return {
      hexKey: strip0x(this.privateKey),
    };
  }

  // The identifier for this key within a set of keys for an enrivonment
  get memoryKeyIdentifier() {
    return this.isValidatorKey
      ? `${this.chainName}-${this.role}-${this.index}`
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
    const secret: SecretManagerPersistedKeys = await fetchGCPSecret(
      this.identifier,
    );
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
    if (this.isValidatorKey) {
      labels += `,chain=${this.chainName},index=${this.index}`;
    }

    await writeFile(
      fileName,
      JSON.stringify({
        role: this.role,
        environment: this.environment,
        privateKey: wallet.privateKey,
        address,
        ...include(this.isValidatorKey, { chainName: this.chainName }),
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
      if (isValidatorKey(role)) {
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
    `gcloud secrets delete ${addressesIdentifier(environment)} --quiet`,
  );
}

// The identifier for a key within a memory representation
export function memoryKeyIdentifier(role: string, chainName: string) {
  return isValidatorKey(role) ? `${chainName}-${role}` : role;
}

export async function createAgentGCPKeys(
  environment: string,
  chainNames: string[],
  validatorCount: number,
) {
  const keys: AgentGCPKey[] = await Promise.all(
    KEY_ROLES.flatMap((role) => {
      if (isValidatorKey(role)) {
        // For each chainName, create validatorCount keys
        return chainNames.flatMap((chainName) =>
          [...Array(validatorCount).keys()].map((index) =>
            AgentGCPKey.create(environment, role, chainName, index),
          ),
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
  const identifier = addressesIdentifier(environment);
  const fileName = `${identifier}.txt`;
  await writeFile(fileName, JSON.stringify(keys));
  if (create) {
    await execCmd(
      `gcloud secrets create ${identifier} --data-file=${fileName} --replication-policy=automatic --labels=environment=${environment}`,
    );
  } else {
    await execCmd(
      `gcloud secrets versions add ${identifier} --data-file=${fileName}`,
    );
  }
  await rm(fileName);
}

// This function returns all the GCP keys for a given outbox chain in a dictionary where the key is either the role or `${chainName}-${role}` in the case of attestation keys
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
  const addresses = await fetchGCPSecret(addressesIdentifier(environment));
  return addresses as KeyAsAddress[];
}

function addressesIdentifier(environment: string) {
  return `abacus-${environment}-key-addresses`;
}
