import { ethers } from 'ethers';
import { Pair } from 'yaml';
import { Provider as ZkProvider, Wallet as ZkWallet } from 'zksync-ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';
import { Role } from '../roles.js';
import { assertChain, assertContext, assertRole } from '../utils/utils.js';

import { parseKeyIdentifier } from './agent.js';

// Base class to represent keys used to run Hyperlane agents.
export abstract class BaseAgentKey {
  constructor(
    public readonly environment: DeployEnvironment,
    public readonly role: Role,
    public readonly chainName?: ChainName,
  ) {}

  abstract get address(): string;

  // By default, only Ethereum keys are supported. Subclasses may override
  // this to support other protocols.
  addressForProtocol(protocol: ProtocolType): string | undefined {
    if (protocol === ProtocolType.Ethereum) {
      return this.address;
    }
    return undefined;
  }
}

// Base class to represent cloud-hosted keys used to run Hyperlane agents.
export abstract class BaseCloudAgentKey extends BaseAgentKey {
  abstract get context(): Contexts;

  abstract get identifier(): string;
}

// Base class to represent cloud-hosted keys for which the current
// process has the credentials.
export abstract class CloudAgentKey extends BaseCloudAgentKey {
  protected constructor(
    public readonly environment: DeployEnvironment,
    public readonly context: Contexts,
    public readonly role: Role,
    public readonly chainName?: ChainName,
    public readonly index?: number,
  ) {
    super(environment, role, chainName);
  }

  abstract fetch(): Promise<void>;

  abstract createIfNotExists(): Promise<void>;

  abstract exists(): Promise<boolean>;

  abstract delete(): Promise<void>;

  // Returns new address
  abstract update(): Promise<string>;

  abstract getSigner(
    provider?: ethers.providers.Provider | ZkProvider,
  ): Promise<ethers.Signer | ZkWallet>;

  abstract privateKey: string;

  serializeAsAddress() {
    return {
      identifier: this.identifier,
      address: this.address,
    };
  }
}

export class LocalAgentKey extends BaseAgentKey {
  constructor(
    public readonly environment: DeployEnvironment,
    public readonly context: Contexts,
    public readonly role: Role,
    public readonly address: string,
    public readonly chainName?: ChainName,
  ) {
    super(environment, role, chainName);
  }
}

// A read-only representation of a key managed internally.
export class ReadOnlyCloudAgentKey extends BaseCloudAgentKey {
  constructor(
    public readonly environment: DeployEnvironment,
    public readonly context: Contexts,
    public readonly role: Role,
    public readonly identifier: string,
    public readonly address: string,
    public readonly chainName?: ChainName,
    public readonly index?: number,
  ) {
    super(environment, role, chainName);
  }

  /**
   * Parses the identifier, deriving the environment, role, chain (if any), and index (if any)
   * and constructs a ReadOnlyAgentKey.
   * @param identifier The "identifier" of the key. This can come in a few different
   * flavors, e.g.:
   * alias/hyperlane-testnet2-key-kathy (<-- hyperlane context, not specific to any chain)
   * alias/hyperlane-testnet2-key-optimismkovan-relayer (<-- hyperlane context, chain specific)
   * alias/hyperlane-testnet2-key-alfajores-validator-0 (<-- hyperlane context, chain specific and has an index)
   * hyperlane-dev-key-kathy (<-- same idea as above, but without the `alias/` prefix if it's not AWS-based)
   * alias/flowcarbon-testnet2-key-optimismkovan-relayer (<-- flowcarbon context & chain specific, intended to show that there are non-hyperlane contexts)
   * @param address The address of the key.
   * @returns A ReadOnlyAgentKey for the provided identifier and address.
   */
  static fromSerializedAddress(
    identifier: string,
    address: string,
  ): ReadOnlyCloudAgentKey {
    const { environment, context, role, chainName, index } =
      parseKeyIdentifier(identifier);
    // apparently importing `environments` config breaks everything
    // console.assert(
    //   environment in environments,
    //   `Invalid environment parsed: ${environment}`,
    // );

    return new ReadOnlyCloudAgentKey(
      environment as DeployEnvironment,
      assertContext(context),
      assertRole(role),
      identifier,
      address,
      chainName ? assertChain(chainName) : undefined,
      index,
    );
  }
}
