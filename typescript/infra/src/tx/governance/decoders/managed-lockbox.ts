import { ethers } from 'ethers';

import type { GovernanceDecoder } from '../types.js';
import { formatFunctionFragmentArgs } from '../utils.js';

const lockboxes = {
  optimism: '0x18C4CdC2d774c047Eac8375Bb09853c4D6D6dF36',
  base: '0xE92e51D99AE33114C60D9621FB2E1ec0ACeA7E30',
};

const roleMap: Record<string, string> = {
  [ethers.constants.HashZero]: 'DEFAULT_ADMIN_ROLE',
  [ethers.utils.id('MANAGER')]: 'MANAGER',
};

const managedLockboxInterface = new ethers.utils.Interface([
  'function deposit(uint256 _amount) nonpayable',
  'function disableDeposits() nonpayable',
  'function enableDeposits() nonpayable',
  'function grantRole(bytes32 role, address account) nonpayable',
  'function renounceRole(bytes32 role, address callerConfirmation) nonpayable',
  'function revokeRole(bytes32 role, address account) nonpayable',
  'function withdraw(uint256 _amount) nonpayable',
  'function withdrawTo(address _to, uint256 _amount) nonpayable',
]);

export function createManagedLockboxDecoder(): GovernanceDecoder {
  return {
    id: 'managed-lockbox',
    priority: 90,
    match: ({ chain, tx }) => {
      if (!tx.to || !(chain in lockboxes)) return undefined;
      return tx.to.toLowerCase() ===
        lockboxes[chain as keyof typeof lockboxes].toLowerCase()
        ? true
        : undefined;
    },
    decode: async ({ chain, tx }) => {
      if (!tx.data) {
        throw new Error('No data in Managed Lockbox transaction');
      }

      let decoded;
      try {
        decoded = managedLockboxInterface.parseTransaction({
          data: tx.data,
          value: tx.value,
        });
      } catch (error) {
        throw new Error(
          `Failed to decode Managed Lockbox transaction: ${error}`,
        );
      }

      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );
      let insight;
      if (
        decoded.functionFragment.name ===
        managedLockboxInterface.functions['grantRole(bytes32,address)'].name
      ) {
        const role = args.role;
        const account = args.account;
        const roleName = roleMap[role] ? ` ${roleMap[role]}` : '';
        insight = `Grant role${roleName} to ${account}`;
      } else {
        insight = 'Unknown function in Managed Lockbox transaction';
      }

      return {
        to: `${tx.to} (Managed Lockbox)`,
        chain,
        insight,
      };
    },
  };
}
