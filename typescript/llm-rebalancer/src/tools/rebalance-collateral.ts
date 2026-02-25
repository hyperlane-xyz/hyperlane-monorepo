/**
 * rebalance_collateral — move router collateral from one chain to another
 * via MovableCollateralRouter.rebalance(). Same-asset, cross-chain only.
 */

import { ethers } from 'ethers';

import type { RebalancerAgentConfig } from '../config.js';

import { resolveNode, extractMessageId, textResult } from './shared.js';

const WARP_REBALANCE_ABI = [
  'function rebalance(uint32, uint256, address) payable',
];

export function buildRebalanceCollateralTool(
  agentConfig: RebalancerAgentConfig,
): any {
  return {
    name: 'rebalance_collateral',
    label: 'Rebalance Collateral',
    description:
      'Move router collateral directly from one chain to another (same-asset, cross-chain). ' +
      'Calls MovableCollateralRouter.rebalance() on the source warp token. ' +
      'Preferred for same-asset distribution imbalances. ' +
      'Node IDs: "USDC|chain1" (multi-asset) or "chain1" (single-asset).',
    parameters: {
      type: 'object',
      required: ['source', 'destination', 'amount'],
      properties: {
        source: {
          type: 'string',
          description: 'Source node ID — router with surplus collateral',
        },
        destination: {
          type: 'string',
          description: 'Destination node ID — same asset, different chain',
        },
        amount: { type: 'string', description: 'Amount in smallest unit' },
      },
    },
    async execute(
      _toolCallId: string,
      params: { source: string; destination: string; amount: string },
    ) {
      try {
        const src = resolveNode(agentConfig, params.source);
        const dst = resolveNode(agentConfig, params.destination);

        if (src.symbol !== dst.symbol) {
          return textResult(
            `rebalance_collateral requires same asset. Got ${src.symbol ?? 'default'} → ${dst.symbol ?? 'default'}. Use inventory bridge + supply_collateral for cross-asset.`,
          );
        }
        if (src.chain === dst.chain) {
          return textResult(
            `rebalance_collateral requires different chains. Source and destination are both ${src.chain}.`,
          );
        }
        if (!src.bridge || src.bridge === ethers.constants.AddressZero) {
          return textResult(
            `No bridge configured for ${params.source}. Use supply_collateral with wallet inventory instead.`,
          );
        }

        const amount = ethers.BigNumber.from(params.amount);
        const provider = new ethers.providers.JsonRpcProvider(src.rpcUrl);
        const wallet = new ethers.Wallet(agentConfig.rebalancerKey, provider);

        const warp = new ethers.Contract(
          src.warpToken,
          WARP_REBALANCE_ABI,
          wallet,
        );
        const tx = await warp.rebalance(dst.domainId, amount, src.bridge);
        const receipt = await tx.wait();
        const messageId = extractMessageId(receipt);

        return textResult(
          JSON.stringify({
            status: 'ok',
            action: 'rebalance_collateral',
            source: params.source,
            destination: params.destination,
            amount: params.amount,
            messageId,
            txHash: receipt.transactionHash,
          }),
        );
      } catch (error) {
        return textResult(
          `rebalance_collateral failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
