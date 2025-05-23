import { ChainMap } from '@hyperlane-xyz/sdk';

import { ContextAndRoles, ContextAndRolesMap } from '../config/funding.js';
import { Role } from '../roles.js';
import { assertContext, assertRole } from '../utils/utils.js';

export const L2_CHAINS = ['optimism', 'arbitrum', 'base'];
export const L1_CHAIN = 'ethereum';

// Utility function to create a timeout promise
export function createTimeoutPromise(
  timeoutMs: number,
  errorMessage: string,
): { promise: Promise<void>; cleanup: () => void } {
  let cleanup: () => void;
  const promise = new Promise<void>((_, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(errorMessage)),
      timeoutMs,
    );
    cleanup = () => clearTimeout(timeout);
  });
  return { promise, cleanup: cleanup! };
}

export function parseContextAndRolesMap(strs: string[]): ContextAndRolesMap {
  const contextsAndRoles = strs.map(parseContextAndRoles);
  return contextsAndRoles.reduce(
    (prev, curr) => ({
      ...prev,
      [curr.context]: curr.roles,
    }),
    {},
  );
}

// Parses strings of the form <context>=<role>,<role>,<role>...
// e.g.:
//   hyperlane=relayer
//   flowcarbon=relayer,kathy
export function parseContextAndRoles(str: string): ContextAndRoles {
  const [contextStr, rolesStr] = str.split('=');
  const context = assertContext(contextStr);

  const roles = rolesStr.split(',').map(assertRole);
  if (roles.length === 0) {
    throw Error('Expected > 0 roles');
  }

  // For now, restrict the valid roles we think are reasonable to want to fund
  const validRoles = new Set([Role.Relayer, Role.Kathy]);
  for (const role of roles) {
    if (!validRoles.has(role)) {
      throw Error(
        `Invalid fundable role ${role}, must be one of ${Array.from(
          validRoles,
        )}`,
      );
    }
  }

  return {
    context,
    roles,
  };
}

export function parseBalancePerChain(strs: string[]): ChainMap<string> {
  const balanceMap: ChainMap<string> = {};
  strs.forEach((str) => {
    const [chain, balance] = str.split('=');
    if (!chain || !balance) {
      throw new Error(`Invalid format for balance entry: ${str}`);
    }
    balanceMap[chain] = balance;
  });
  return balanceMap;
}
