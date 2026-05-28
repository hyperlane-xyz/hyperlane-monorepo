import { ethers } from 'ethers';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { tokens } from '../../../config/warp.js';
import type { GovernanceDecoder } from '../types.js';
import { formatFunctionFragmentArgs } from '../utils.js';

const ERC20_SELECTORS = new Set([
  '0xa9059cbb', // transfer(address,uint256)
  '0x095ea7b3', // approve(address,uint256)
  '0x23b872dd', // transferFrom(address,address,uint256)
  '0x39509351', // increaseAllowance(address,uint256)
  '0xa457c2d7', // decreaseAllowance(address,uint256)
]);

export function createErc20Decoder(): GovernanceDecoder {
  return {
    id: 'erc20',
    priority: 70,
    match: ({ state, chain, tx }) => {
      if (!tx.to || !tx.data) return undefined;

      const selector = tx.data.slice(0, 10).toLowerCase();
      if (!ERC20_SELECTORS.has(selector)) return undefined;

      const chainTokens = tokens[chain as keyof typeof tokens];
      const isKnownToken =
        chainTokens &&
        Object.values(chainTokens).some((address) =>
          eqAddress(tx.to!, address),
        );

      const isWarpRoute =
        state.warpRouteIndex[chain] !== undefined &&
        state.warpRouteIndex[chain][tx.to.toLowerCase()] !== undefined;

      return isKnownToken || isWarpRoute ? true : undefined;
    },
    decode: async ({ state, chain, tx }) => {
      if (!tx.data) {
        throw new Error('No data in ERC20 transaction');
      }

      if (!tx.to) {
        throw new Error('No to address in ERC20 transaction');
      }

      const erc20Interface = ERC20__factory.createInterface();
      const decoded = erc20Interface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      const erc20 = ERC20__factory.connect(
        tx.to,
        state.multiProvider.getProvider(chain),
      );

      const decimals = await erc20.decimals();
      const symbol = await erc20.symbol();

      let insight;
      switch (decoded.functionFragment.name) {
        case erc20Interface.functions['transfer(address,uint256)'].name: {
          const [to, amount] = decoded.args;
          const numTokens = ethers.utils.formatUnits(amount, decimals);
          insight = `Transfer ${numTokens} ${symbol} to ${to}`;
          break;
        }
        case erc20Interface.functions['approve(address,uint256)'].name: {
          const [spender, amount] = decoded.args;
          const numTokens = ethers.utils.formatUnits(amount, decimals);
          insight = `Approve ${numTokens} ${symbol} for ${spender}`;
          break;
        }
        case erc20Interface.functions['transferFrom(address,address,uint256)']
          .name: {
          const [from, to, amount] = decoded.args;
          const numTokens = ethers.utils.formatUnits(amount, decimals);
          insight = `Transfer ${numTokens} ${symbol} from ${from} to ${to}`;
          break;
        }
        case erc20Interface.functions['increaseAllowance(address,uint256)']
          .name: {
          const [spender, addedValue] = decoded.args;
          insight = `Increase allowance for ${spender} by ${addedValue.toString()}`;
          break;
        }
        case erc20Interface.functions['decreaseAllowance(address,uint256)']
          .name: {
          const [spender, subtractedValue] = decoded.args;
          insight = `Decrease allowance for ${spender} by ${subtractedValue.toString()}`;
          break;
        }
      }

      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );

      return {
        chain,
        to: `${symbol} (${chain} ${tx.to})`,
        insight,
        args,
      };
    },
  };
}
