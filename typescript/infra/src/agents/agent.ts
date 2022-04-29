import { KEY_ROLE_ENUM } from '../agents';

export abstract class AgentKey {
  abstract get identifier(): string;
  abstract get address(): string;

  abstract fetch(): Promise<void>;
}

export function isValidatorKey(role: string) {
  return role === KEY_ROLE_ENUM.Validator;
}

export function identifier(
  environment: string,
  role: string,
  chainName: string,
  suffix: number | string | undefined,
) {
  return suffix !== undefined
    ? `abacus-${environment}-key-${chainName}-${role}-${suffix}`
    : `abacus-${environment}-key-${chainName}-${role}`;
}
