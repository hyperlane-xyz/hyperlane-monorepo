import { ChainName } from '@abacus-network/sdk';
import { KEY_ROLE_ENUM } from './roles';
import { AgentConfig } from '../config/agent';

export abstract class AgentKey<Networks extends ChainName> {
  environment: string;

  constructor(
    agentConfig: AgentConfig<Networks>,
    public readonly role: KEY_ROLE_ENUM,
    public readonly chainName?: Networks,
    public readonly suffix?: Networks | number,
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
  suffix?: number | string,
) {
  switch (role) {
    case KEY_ROLE_ENUM.Validator:
      if (suffix === undefined) {
        throw Error('Expected suffix for validator key');
      }
      return `abacus-${environment}-key-${chainName}-${role}-${suffix}`;
    case KEY_ROLE_ENUM.Relayer:
      return `abacus-${environment}-key-${chainName}-${role}`;
    default:
      return `abacus-${environment}-key-${role}`;
  }
}
