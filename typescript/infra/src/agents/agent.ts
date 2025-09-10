import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';
import { Role } from '../roles.js';
import { assertRole } from '../utils/utils.js';

export function isValidatorKey(role: Role) {
  return role === Role.Validator;
}

function identifier(
  isKey: boolean,
  environment: string,
  context: Contexts,
  role: Role,
  chainName?: ChainName,
  index?: number,
) {
  const prefix = `${context}-${environment}-${isKey ? 'key-' : ''}`;
  switch (role) {
    case Role.Validator:
      if (!chainName) throw Error('Expected chainName for validator key');
      if (index === undefined) throw Error('Expected index for validator key');
      return `${prefix}${chainName}-${role}-${index}`;
    // In the case of deployer keys not all the keys have the chainName included in their identifier
    case Role.Deployer:
      return `${context}-${environment}-${chainName ? chainName + '-' : ''}${isKey ? 'key-' : ''}${role}`;
    default:
      return `${prefix}${role}`;
  }
}

export function keyIdentifier(
  environment: DeployEnvironment,
  context: Contexts,
  role: Role,
  chainName?: ChainName,
  index?: number,
) {
  return identifier(true, environment, context, role, chainName, index);
}

export function userIdentifier(
  environment: string,
  context: Contexts,
  role: Role,
  chainName?: ChainName,
  index?: number,
) {
  return identifier(false, environment, context, role, chainName, index);
}

// Does not perform any checks on whether the parsed values are valid,
// this is left to the caller.
export function parseKeyIdentifier(identifier: string): {
  environment: string;
  context: string;
  role: Role;
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

  if (matches[5] === undefined) {
    // If matches[5] is undefined, this key doesn't have a chainName, and matches[4]
    // is the role name.
    return {
      context,
      environment,
      role: assertRole(matches[4]),
    };
  } else if (matches[6] === undefined) {
    // If matches[6] is undefined, this key doesn't have an index.
    return {
      context,
      environment,
      role: assertRole(matches[5]),
      chainName: matches[4],
    };
  }
  return {
    context,
    environment,
    role: assertRole(matches[5]),
    chainName: matches[4],
    index: parseInt(matches[6]),
  };
}
