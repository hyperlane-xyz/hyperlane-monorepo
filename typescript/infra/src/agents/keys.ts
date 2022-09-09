import { ethers } from 'ethers';

import { ChainName } from '@abacus-network/sdk';

import { Contexts } from '../../config/contexts';
import { assertChain, assertContext, assertRole } from '../utils/utils';

import { KEY_ROLE_ENUM } from './roles';

// Base class to represent keys used to run Abacus agents.
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

// Base class to represent cloud-hosted keys used to run Abacus agents.
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
   * alias/abacus-testnet2-key-kathy (<-- abacus context, not specific to any chain)
   * alias/abacus-testnet2-key-optimismkovan-relayer (<-- abacus context, chain specific)
   * alias/abacus-testnet2-key-alfajores-validator-0 (<-- abacus context, chain specific and has an index)
   * abacus-dev-key-kathy (<-- same idea as above, but without the `alias/` prefix if it's not AWS-based)
   * alias/flowcarbon-testnet2-key-optimismkovan-relayer (<-- flowcarbon context & chain specific, intended to show that there are non-abacus contexts)
   * @param address The address of the key.
   * @returns A ReadOnlyAgentKey for the provided identifier and address.
   */
  static fromSerializedAddress(
    identifier: string,
    address: string,
  ): ReadOnlyCloudAgentKey {
    const regex =
      /(alias\/)?([a-zA-Z0-9]+)-([a-zA-Z0-9]+)-key-([a-zA-Z0-9]+)-?([a-zA-Z0-9]+)?-?([0-9]+)?/g;
    const matches = regex.exec(identifier);
    if (!matches) {
      throw Error('Invalid identifier');
    }
    const context = assertContext(matches[2]);
    const environment = matches[3];

    // If matches[5] is undefined, this key doesn't have a chainName, and matches[4]
    // is the role name.
    if (matches[5] === undefined) {
      return new ReadOnlyCloudAgentKey(
        environment,
        context,
        assertRole(matches[4]),
        identifier,
        address,
      );
    } else if (matches[6] === undefined) {
      // If matches[6] is undefined, this key doesn't have an index.
      return new ReadOnlyCloudAgentKey(
        environment,
        context,
        assertRole(matches[5]),
        identifier,
        address,
        assertChain(matches[4]),
      );
    } else {
      return new ReadOnlyCloudAgentKey(
        environment,
        context,
        assertRole(matches[5]),
        identifier,
        address,
        assertChain(matches[4]),
        parseInt(matches[6]),
      );
    }
  }
}
