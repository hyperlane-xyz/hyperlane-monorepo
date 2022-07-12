import { ChainName } from '@abacus-network/sdk';

import { assertChain, assertRole } from '../utils/utils';

import { KEY_ROLE_ENUM } from './roles';

export abstract class AgentKey {
  constructor(
    public environment: string,
    public readonly role: KEY_ROLE_ENUM,
    public readonly chainName?: ChainName,
    public readonly index?: number,
  ) {}

  abstract get identifier(): string;
  abstract get address(): string;

  abstract fetch(): Promise<void>;

  abstract createIfNotExists(): Promise<void>;
  abstract delete(): Promise<void>;
  // Returns new address
  abstract update(): Promise<string>;

  serializeAsAddress() {
    return {
      identifier: this.identifier,
      address: this.address,
    };
  }
}

export class ReadOnlyAgentKey extends AgentKey {
  private _identifier: string;
  private _address: string;

  constructor(
    public environment: string,
    public readonly role: KEY_ROLE_ENUM,
    identifier: string,
    address: string,
    public readonly chainName?: ChainName,
    public readonly index?: number,
  ) {
    super(environment, role, chainName, index);

    this._identifier = identifier;
    this._address = address;
  }

  /**
   * Parses the identifier, deriving the environment, role, chain (if any), and index (if any)
   * and constructs a ReadOnlyAgentKey.
   * @param identifier The "identifier" of the key. This can come in a few different
   * flavors, e.g.:
   * alias/abacus-testnet2-key-kathy (<-- not specific to any chain)
   * alias/abacus-testnet2-key-optimismkovan-relayer (<-- chain specific)
   * alias/abacus-testnet2-key-alfajores-validator-0 (<-- chain specific and has an index)
   * abacus-dev-key-kathy (<-- same idea as above, but without the `alias/` prefix if it's not AWS-based)
   * @param address The address of the key.
   * @returns A ReadOnlyAgentKey for the provided identifier and address.
   */
  static fromSerializedAddress(
    identifier: string,
    address: string,
  ): ReadOnlyAgentKey {
    const regex =
      /.*abacus-([a-zA-Z0-9]+)-key-([a-zA-Z0-9]+)-?([a-zA-Z0-9]+)?-?([0-9]+)?/g;
    const matches = regex.exec(identifier);
    if (!matches) {
      throw Error('Invalid identifier');
    }
    const environment = matches[1];

    // If matches[3] is undefined, this key doesn't have a chainName, and matches[2]
    // is the role name.
    if (matches[3] === undefined) {
      return new ReadOnlyAgentKey(
        environment,
        assertRole(matches[2]),
        identifier,
        address,
      );
    } else if (matches[4] === undefined) {
      // If matches[4] is undefined, this key doesn't have an index.
      return new ReadOnlyAgentKey(
        environment,
        assertRole(matches[3]),
        identifier,
        address,
        assertChain(matches[2]),
      );
    } else {
      return new ReadOnlyAgentKey(
        environment,
        assertRole(matches[3]),
        identifier,
        address,
        assertChain(matches[2]),
        parseInt(matches[4]),
      );
    }
  }

  get identifier(): string {
    return this._identifier;
  }

  get address(): string {
    return this._address;
  }

  async fetch(): Promise<void> {
    // No-op
  }

  async createIfNotExists(): Promise<void> {
    throw Error('Not supported');
  }

  async delete(): Promise<void> {
    throw Error('Not supported');
  }

  async update(): Promise<string> {
    throw Error('Not supported');
  }
}

export function isValidatorKey(role: string) {
  return role === KEY_ROLE_ENUM.Validator;
}

function identifier(
  isKey: boolean,
  environment: string,
  role: string,
  chainName?: ChainName,
  index?: number,
) {
  const prefix = `abacus-${environment}-${isKey ? 'key-' : ''}`;
  switch (role) {
    case KEY_ROLE_ENUM.Validator:
      if (index === undefined) {
        throw Error('Expected index for validator key');
      }
      return `${prefix}${chainName}-${role}-${index}`;
    case KEY_ROLE_ENUM.Relayer:
      if (chainName === undefined) {
        throw Error('Expected chainName for relayer key');
      }
      return `${prefix}${chainName}-${role}`;
    default:
      return `${prefix}${role}`;
  }
}

export function keyIdentifier(
  environment: string,
  role: string,
  chainName?: ChainName,
  index?: number,
) {
  return identifier(true, environment, role, chainName, index);
}

export function userIdentifier(
  environment: string,
  role: string,
  chainName?: ChainName,
  index?: number,
) {
  return identifier(false, environment, role, chainName, index);
}
