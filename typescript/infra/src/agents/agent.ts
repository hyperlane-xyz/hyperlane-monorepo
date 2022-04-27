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
  index: number | undefined,
) {
  return isValidatorKey(role)
    ? `abacus-${environment}-key-${chainName}-${role}-${index}`
    : `abacus-${environment}-key-${role}`;
}
