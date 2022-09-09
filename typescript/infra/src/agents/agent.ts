import { ChainName } from '@abacus-network/sdk';

import { Contexts } from '../../config/contexts';

import { KEY_ROLE_ENUM } from './roles';

export function isValidatorKey(role: string) {
  return role === KEY_ROLE_ENUM.Validator;
}

function identifier(
  isKey: boolean,
  environment: string,
  context: Contexts,
  role: string,
  chainName?: ChainName,
  index?: number,
) {
  const prefix = `${context}-${environment}-${isKey ? 'key-' : ''}`;
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
  context: Contexts,
  role: string,
  chainName?: ChainName,
  index?: number,
) {
  return identifier(true, environment, context, role, chainName, index);
}

export function userIdentifier(
  environment: string,
  context: Contexts,
  role: string,
  chainName?: ChainName,
  index?: number,
) {
  return identifier(false, environment, context, role, chainName, index);
}
