import { Wallet } from 'ethers';
import { ChainName } from '@abacus-network/sdk';
import { /*KEY_ROLES,*/ KEY_ROLE_ENUM } from '../agents';
import { execCmd, include } from '../utils/utils';
import { AgentKey, isValidatorKey, identifier } from './agent';
import { fetchGCPSecret, setGCPSecret } from '../utils/gcloud';
import { AgentConfig } from '../config';
import { getAllKeys } from './index';

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
  identifier: string;
  address: string;
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

export class AgentGCPKey<Networks extends ChainName> extends AgentKey<Networks> {
  constructor(
    agentConfig: AgentConfig<Networks>,
    role: KEY_ROLE_ENUM,
    chainName?: Networks,
    suffix?: Networks | number,
    private remoteKey: RemoteKey = { fetched: false },
  ) {
    super(
      agentConfig,
      role,
      chainName,
      suffix,
    );
  }

  async createIfNotExists() {
    try {
      await this.fetch();
    } catch (err) {
      await this.create();
    }
  }

  serializeAsAddress() {
    this.requireFetched();
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
    return identifier(this.environment, this.role, this.chainName, this.suffix);
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

    await setGCPSecret(
      identifier,
      JSON.stringify({
        role: this.role,
        environment: this.environment,
        privateKey: wallet.privateKey,
        address,
        ...include(this.isValidatorKey, { chainName: this.chainName }),
      }),
      {
        environment: this.environment,
        role: this.role,
        ...include(this.isValidatorKey, {
          chain: this.chainName,
          index: this.suffix,
        }),
      },
    );

    return {
      fetched: true,
      privateKey: wallet.privateKey,
      address,
    };
  }
}

export async function deleteAgentGCPKeys(
  _environment: string,
  _chainNames: string[],
) {
  // await Promise.all(
  //   KEY_ROLES.map(async (role) => {
  //     if (isValidatorKey(role)) {
  //       await Promise.all(
  //         chainNames.map((chainName) => {
  //           const key = new AgentGCPKey(environment, role, chainName);
  //           return key.delete();
  //         }),
  //       );
  //     } else {
  //       const key = new AgentGCPKey(environment, role, 'any');
  //       await key.delete();
  //     }
  //   }),
  // );
  // await execCmd(
  //   `gcloud secrets delete ${addressesIdentifier(environment)} --quiet`,
  // );
}

export async function createAgentKeysIfNotExists<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>
) {
  const keys = getAllKeys(agentConfig);

  await Promise.all(
    keys.map((key) => key.createIfNotExists())
  );

  await persistAddresses(
    agentConfig.environment,
    keys.map((key) => key.serializeAsAddress()),
  );
}

export async function rotateGCPKey(
  _environment: string,
  _role: string,
  _chainName: string,
) {
  // const key = new AgentGCPKey(environment, role, chainName);
  // await key.update();
  // const keyIdentifier = key.identifier;
  // const addresses = await fetchGCPKeyAddresses(environment);
  // const filteredAddresses = addresses.filter((_) => {
  //   return _.identifier !== keyIdentifier;
  // });

  // filteredAddresses.push(key.serializeAsAddress());
  // await persistAddresses(environment, filteredAddresses);
}

async function persistAddresses(environment: string, keys: KeyAsAddress[]) {
  await setGCPSecret(addressesIdentifier(environment), JSON.stringify(keys), {
    environment: environment,
  });
}

// This function returns all the GCP keys for a given outbox chain in a dictionary where the key is the identifier
export async function fetchAgentGCPKeys<Networks extends ChainName>(
  _agentConfig: AgentConfig<Networks>,
  _chainName: Networks,
  _validatorCount: number,
): Promise<Record<string, AgentGCPKey<Networks>>> {
  // const environment = agentConfig.environment;
  // const secrets = await Promise.all(
  //   KEY_ROLES.map(async (role) => {
  //     if (role === KEY_ROLE_ENUM.Validator) {
  //       return Promise.all(
  //         [...Array(validatorCount).keys()].map(async (index) => {
  //           const key = new AgentGCPKey(environment, role, chainName, index);
  //           await key.fetch();
  //           return [key.identifier, key];
  //         }),
  //       );
  //     } else if (role === KEY_ROLE_ENUM.Relayer) {
  //       return Promise.all(
  //         agentConfig
  //           .domainNames
  //           .filter((d) => d !== chainName)
  //           .map(async (remote) => {
  //             const key = new AgentGCPKey(environment, role, chainName, remote);
  //             await key.fetch();
  //             return [key.identifier, key];
  //           })
  //       );
  //     } else {
  //       const key = new AgentGCPKey(environment, role, chainName);
  //       await key.fetch();
  //       return [[key.identifier, key]];
  //     }
  //   }),
  // );

  // return Object.fromEntries(secrets.flat(1));
  return {};
}

// async function fetchGCPKeyAddresses(environment: string) {
//   const addresses = await fetchGCPSecret(addressesIdentifier(environment));
//   return addresses as KeyAsAddress[];
// }

function addressesIdentifier(environment: string) {
  return `abacus-${environment}-key-addresses`;
}
