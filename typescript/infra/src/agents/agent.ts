import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from '../config/agent';

import { KEY_ROLE_ENUM } from './roles';

export abstract class AgentKey<Networks extends ChainName> {
  environment: string;

  constructor(
    agentConfig: AgentConfig<Networks>,
    public readonly role: KEY_ROLE_ENUM,
    public readonly chainName?: Networks,
    public readonly index?: number,
  ) {
    this.environment = agentConfig.environment;
  }

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

export function isValidatorKey(role: string) {
  return role === KEY_ROLE_ENUM.Validator;
}

export function identifier(
  environment: string,
  role: string,
  chainName?: string,
  index?: number,
) {
  switch (role) {
    case KEY_ROLE_ENUM.Validator:
      if (index === undefined) {
        throw Error('Expected index for validator key');
      }
      return `abacus-${environment}-key-${chainName}-${role}-${index}`;
    case KEY_ROLE_ENUM.Relayer:
      if (chainName === undefined) {
        throw Error('Expected chainName for relayer key');
      }
      return `abacus-${environment}-key-${chainName}-${role}`;
    default:
      return `abacus-${environment}-key-${role}`;
  }
}
