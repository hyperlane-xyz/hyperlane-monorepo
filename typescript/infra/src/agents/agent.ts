import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { DeployEnvironment } from '../config';

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
  environment: DeployEnvironment,
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

// Doesn't perform any checks on whether the parsed values are valid,
// this is left to the caller.
export function parseKeyIdentifier(identifier: string): {
  environment: string;
  context: string;
  role: string;
  chainName?: string;
  index?: number;
} {
  const regex =
    /(alias\/)?([a-zA-Z0-9]+)-([a-zA-Z0-9]+)-key-([a-zA-Z0-9]+)-?([a-zA-Z0-9]+)?-?([0-9]+)?/g;
  const matches = regex.exec(identifier);
  if (!matches) {
    throw Error('Invalid identifier');
  }
  const context = matches[2];
  const environment = matches[3];

  // If matches[5] is undefined, this key doesn't have a chainName, and matches[4]
  // is the role name.
  if (matches[5] === undefined) {
    return {
      environment,
      context,
      role: matches[4],
    };
  } else if (matches[6] === undefined) {
    // If matches[6] is undefined, this key doesn't have an index.
    return {
      environment,
      context,
      role: matches[5],
      chainName: matches[4],
    };
  }
  return {
    environment,
    context,
    role: matches[5],
    chainName: matches[4],
    index: parseInt(matches[6]),
  };
}
