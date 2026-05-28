import { ethers } from 'ethers';

import { Ownable__factory } from '@hyperlane-xyz/core';

import type { GovernanceDecoder } from '../types.js';
import { formatFunctionFragmentArgs, getOwnerInsight } from '../utils.js';

const ownableFunctionSelectors = [
  'renounceOwnership()',
  'transferOwnership(address)',
].map((func) => ethers.utils.id(func).substring(0, 10));

export function createOwnableDecoder(): GovernanceDecoder {
  return {
    id: 'ownable',
    priority: 10,
    match: ({ tx }) =>
      tx.to &&
      tx.data &&
      ownableFunctionSelectors.includes(tx.data.substring(0, 10))
        ? true
        : undefined,
    decode: async ({ chain, tx }) => {
      if (!tx.data) {
        throw new Error('⚠️ No data in Ownable transaction');
      }

      const ownableInterface = Ownable__factory.createInterface();
      const decoded = ownableInterface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      let insight;
      if (
        decoded.functionFragment.name ===
        ownableInterface.functions['renounceOwnership()'].name
      ) {
        insight = `Renounce ownership`;
      }

      if (
        decoded.functionFragment.name ===
        ownableInterface.functions['transferOwnership(address)'].name
      ) {
        const [newOwner] = decoded.args;
        const newOwnerInsight = await getOwnerInsight(chain, newOwner);
        insight = `Transfer ownership to ${newOwnerInsight}`;
      }

      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );

      return {
        chain,
        to: `Ownable (${chain} ${tx.to})`,
        ...(insight ? { insight } : { args }),
        signature: decoded.signature,
      };
    },
  };
}
