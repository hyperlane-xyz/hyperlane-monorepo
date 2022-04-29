import { ChainName } from '@abacus-network/sdk';
import { KEY_ROLE_ENUM } from '../agents';
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
    if (
      (role === KEY_ROLE_ENUM.Validator || role === KEY_ROLE_ENUM.Relayer) &&
      suffix === undefined
    ) {
      throw new Error(`Expected suffix for ${role} key`);
    }
  }

  abstract get identifier(): string;
  abstract get address(): string;

  abstract fetch(): Promise<void>;

  abstract createIfNotExists(): Promise<void>;
  abstract delete(): Promise<void>;

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
  const base = chainName !== undefined ?
    `abacus-${environment}-key-${chainName}-${role}` :
    `abacus-${environment}-key-${role}`;
  return suffix !== undefined
    ? `${base}-${suffix}`
    : base;
}
