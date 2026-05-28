import { ethers } from 'ethers';

import { IXERC20VS__factory, IXERC20__factory } from '@hyperlane-xyz/core';
import { TokenStandard } from '@hyperlane-xyz/sdk';

import type { GovernanceDecoder, XERC20Metadata } from '../types.js';
import { formatFunctionFragmentArgs } from '../utils.js';

export function createXerc20Decoder(): GovernanceDecoder<XERC20Metadata> {
  return {
    id: 'xerc20',
    priority: 100,
    match: ({ state, chain, tx }) => {
      if (!tx.to) return undefined;
      return state.xerc20Deployments[chain]?.[tx.to.toLowerCase()];
    },
    decode: async ({ runtime, chain, tx, match: metadata }) => {
      if (!tx.data) {
        throw new Error('No data in XERC20 transaction');
      }

      const vsTokenInterface = IXERC20VS__factory.createInterface();
      const xerc20Interface = IXERC20__factory.createInterface();

      let decoded: ethers.utils.TransactionDescription;
      if (metadata.type === TokenStandard.EvmHypVSXERC20) {
        decoded = vsTokenInterface.parseTransaction({
          data: tx.data,
          value: tx.value,
        });
      } else {
        decoded = xerc20Interface.parseTransaction({
          data: tx.data,
          value: tx.value,
        });
      }

      let insight;
      if (metadata.type === TokenStandard.EvmHypVSXERC20) {
        switch (decoded.functionFragment.name) {
          case vsTokenInterface.functions['setBufferCap(address,uint256)']
            .name: {
            const [bridge, newBufferCap] = decoded.args;
            insight = `Set buffer cap for bridge ${bridge} to ${newBufferCap}`;
            break;
          }
          case vsTokenInterface.functions[
            'setRateLimitPerSecond(address,uint128)'
          ].name: {
            const [bridge, newRateLimit] = decoded.args;
            insight = `Set rate limit per second for bridge ${bridge} to ${newRateLimit}`;
            break;
          }
          case vsTokenInterface.functions[
            'addBridge((uint112,uint128,address))'
          ].name: {
            const [{ bufferCap, rateLimitPerSecond, bridge }] = decoded.args;
            insight = `Add new bridge ${bridge} with buffer cap ${bufferCap} and rate limit ${rateLimitPerSecond}`;
            break;
          }
          case vsTokenInterface.functions['removeBridge(address)'].name: {
            const [bridgeToRemove] = decoded.args;
            insight = `Remove bridge ${bridgeToRemove}`;
            break;
          }
        }
      } else if (
        decoded.functionFragment.name ===
        xerc20Interface.functions['setLimits(address,uint256,uint256)'].name
      ) {
        const [bridge, mintingLimit, burningLimit] = decoded.args;
        insight = `Set limits for bridge ${bridge} - minting limit: ${mintingLimit}, burning limit: ${burningLimit}`;
      }

      if (!insight) {
        switch (decoded.functionFragment.name) {
          case xerc20Interface.functions['mint(address,uint256)'].name: {
            const [to, amount] = decoded.args;
            const numTokens = ethers.utils.formatUnits(
              amount,
              metadata.decimals,
            );
            insight = `Mint ${numTokens} ${metadata.symbol} to ${to}`;
            break;
          }
          case xerc20Interface.functions['approve(address,uint256)'].name: {
            const [spender, amount] = decoded.args;
            const numTokens = ethers.utils.formatUnits(
              amount,
              metadata.decimals,
            );
            insight = `Approve ${numTokens} ${metadata.symbol} for ${spender}`;
            break;
          }
          case xerc20Interface.functions['burn(address,uint256)'].name: {
            const [from, amount] = decoded.args;
            const numTokens = ethers.utils.formatUnits(
              amount,
              metadata.decimals,
            );
            insight = `Burn ${numTokens} ${metadata.symbol} from ${from}`;
            break;
          }
        }
      }

      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );

      let ownableTx = {};
      if (!insight) {
        ownableTx = await runtime.readOwnableTransaction(chain, tx);
      }

      return {
        ...ownableTx,
        to: `${metadata.symbol} (${metadata.name}, ${metadata.type}, ${tx.to})`,
        chain,
        ...(insight ? { insight } : { args }),
        signature: decoded.signature,
      };
    },
  };
}
