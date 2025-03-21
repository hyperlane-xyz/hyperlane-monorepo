import { Interface } from '@ethersproject/abi';

import { IAccessManager__factory } from '@hyperlane-xyz/core';
import { Address, assert } from '@hyperlane-xyz/utils';

import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';

import {
  HyperlaneContracts,
  HyperlaneFactories,
  HyperlaneInterfaces,
} from './types.js';

const RESERVED_ROLES: Record<string, bigint> = {
  ADMIN: 0n, // uint64 min
  PUBLIC: 2n ** 64n - 1n, // uint64 max
};

// modeled after structs from AccessManager.sol
export type TargetConfig<I extends Interface, Role extends string> = {
  authority: Partial<Record<keyof I['functions'], Role>>;
  adminDelay?: number;
  closed?: boolean;
};

export type RoleConfig<Role extends string> = {
  [role in Role]: {
    members: Set<Address>;
    executionDelay?: number;
    grantDelay?: number;
    guardian?: Role;
    admin?: Role;
  };
};

export type AccessManagerConfig<
  Role extends string,
  I extends HyperlaneInterfaces,
> = {
  targets: {
    [K in keyof I]: TargetConfig<I[K], Role>;
  };
  roles: RoleConfig<Role>;
};

export function configureAccess<
  Role extends string,
  F extends HyperlaneFactories,
>(
  contracts: HyperlaneContracts<F>,
  config: AccessManagerConfig<Role, HyperlaneContracts<F>['interface']>,
): AnnotatedEV5Transaction[] {
  let transactions = [];

  const manager = IAccessManager__factory.createInterface();

  const roleIds = RESERVED_ROLES;

  for (const [index, [role, roleConfig]] of Object.entries<
    RoleConfig<Role>[Role]
  >(config.roles).entries()) {
    assert(
      !Object.keys(RESERVED_ROLES).includes(role),
      `Reserved role ${role} assigned`,
    );

    const roleId = BigInt(index) + 1n;
    assert(
      RESERVED_ROLES.ADMIN < roleId && roleId < RESERVED_ROLES.PUBLIC,
      `Reserved role ID ${roleId} assigned`,
    );

    roleIds[role] = roleId;

    for (const member of roleConfig.members) {
      const delay = roleConfig.executionDelay ?? 0;
      const data = manager.encodeFunctionData('grantRole', [
        roleId,
        member,
        delay,
      ]);
      const annotation = `grant role ${role} to ${member} with delay ${delay}`;
      transactions.push({ data, annotation });
    }

    if (roleConfig.guardian) {
      const data = manager.encodeFunctionData('setRoleGuardian', [
        roleId,
        roleConfig.guardian,
      ]);
      const annotation = `set guardian for role ${role} to ${roleConfig.guardian}`;
      transactions.push({ data, annotation });
    }
    if (roleConfig.admin) {
      const data = manager.encodeFunctionData('setRoleAdmin', [
        roleId,
        roleConfig.admin,
      ]);
      const annotation = `set admin for role ${role} to ${roleConfig.admin}`;
      transactions.push({ data, annotation });
    }
    if (roleConfig.grantDelay && roleConfig.grantDelay > 0) {
      const data = manager.encodeFunctionData('setGrantDelay', [
        roleId,
        roleConfig.grantDelay,
      ]);
      const annotation = `set grant delay for role ${role} to ${roleConfig.grantDelay}`;
      transactions.push({ data, annotation });
    }
  }

  for (const target in config.targets) {
    const targetConfig = config.targets[target];
    const contract = contracts[target];

    for (const func in targetConfig.authority) {
      const authority = targetConfig.authority[func];
      assert(authority && roleIds[authority], `Invalid authority ${authority}`);
      const roleId = roleIds[authority];

      const selector = contract.interface.getSighash(func);
      const data = manager.encodeFunctionData('setTargetFunctionRole', [
        contract.address,
        [selector],
        roleId,
      ]);
      const annotation = `set authority for ${target}.${func} to role ${authority}`;
      transactions.push({ data, annotation });
    }

    if (targetConfig.adminDelay && targetConfig.adminDelay > 0) {
      const data = manager.encodeFunctionData('setTargetAdminDelay', [
        contract.address,
        targetConfig.adminDelay,
      ]);
      const annotation = `set admin delay for ${target} to ${targetConfig.adminDelay}`;
      transactions.push({ data, annotation });
    }
  }

  return transactions;
}
