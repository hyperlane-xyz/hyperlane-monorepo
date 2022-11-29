import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { assertChain, assertContext, assertRole } from '../utils/utils';

import { parseKeyIdentifier } from './agent';
import { KEY_ROLE_ENUM } from './roles';

// Base class to represent keys used to run Hyperlane agents.
export abstract class BaseAgentKey {
  constructor(
    public readonly environment: string,
    public readonly role: KEY_ROLE_ENUM,
    public readonly chainName?: ChainName,
    public readonly readonly = true,
  ) {}

  abstract get address(): string;
}

// A read-only representation of a key.
export class ReadOnlyAgentKey extends BaseAgentKey {
  constructor(
    public environment: string,
    public readonly role: KEY_ROLE_ENUM,
    public readonly address: string,
    public readonly chainName?: ChainName,
  ) {
    super(environment, role, chainName);
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
  constructor(
    public readonly environment: string,
    public readonly context: Contexts,
    public readonly role: KEY_ROLE_ENUM,
    public readonly chainName?: ChainName,
    public readonly index?: number,
  ) {
    super(environment, role, chainName, false);
  }

  abstract fetch(): Promise<void>;

  abstract createIfNotExists(): Promise<void>;
  abstract delete(): Promise<void>;
  // Returns new address
  abstract update(): Promise<string>;

  abstract getSigner(
    provider?: ethers.providers.Provider,
  ): Promise<ethers.Signer>;

  serializeAsAddress() {
    return {
      identifier: this.identifier,
      address: this.address,
    };
  }
}

// A read-only representation of a key managed internally.
export class ReadOnlyCloudAgentKey extends BaseCloudAgentKey {
  constructor(
    public readonly environment: string,
    public readonly context: Contexts,
    public readonly role: KEY_ROLE_ENUM,
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

    return new ReadOnlyCloudAgentKey(
      environment,
      assertContext(context),
      assertRole(role),
      identifier,
      address,
      chainName ? assertChain(chainName) : undefined,
      index,
    );
  }
}
