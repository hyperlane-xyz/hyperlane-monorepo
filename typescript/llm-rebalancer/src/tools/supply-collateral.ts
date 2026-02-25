/**
 * supply_collateral — supply collateral to a router from wallet inventory.
 * Same-asset only. Same-chain = instant transfer. Cross-chain = approve + bridge.transferRemote().
 */

import { ethers } from 'ethers';

import type { RebalancerAgentConfig } from '../config.js';

import { resolveNode, extractMessageId, textResult } from './shared.js';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256)',
  'function transfer(address, uint256) returns (bool)',
];

const BRIDGE_TRANSFER_REMOTE_ABI = [
  'function transferRemote(uint32, bytes32, uint256) payable returns (bytes32)',
];

export function buildSupplyCollateralTool(
  agentConfig: RebalancerAgentConfig,
): any {
  return {
    name: 'supply_collateral',
    label: 'Supply Collateral',
    description:
      'Supply collateral to a router from your wallet inventory (same-asset). ' +
      'Same-chain: instant transfer. Cross-chain: via bridge (has delivery delay). ' +
      'Node IDs: "USDC|chain1" (multi-asset) or "chain1" (single-asset).',
    parameters: {
      type: 'object',
      required: ['source', 'destination', 'amount'],
      properties: {
        source: {
          type: 'string',
          description: 'Source node ID — where your wallet has inventory',
        },
        destination: {
          type: 'string',
          description: 'Destination node ID — which router to supply',
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
            `supply_collateral requires same asset. Got ${src.symbol ?? 'default'} → ${dst.symbol ?? 'default'}. Use an inventory bridge first to convert.`,
          );
        }

        const amount = ethers.BigNumber.from(params.amount);
        const provider = new ethers.providers.JsonRpcProvider(src.rpcUrl);
        const wallet = new ethers.Wallet(agentConfig.rebalancerKey, provider);

        // Check wallet balance
        const token = new ethers.Contract(
          src.collateralToken,
          ERC20_ABI,
          wallet,
        );
        const balance: ethers.BigNumber = await token.balanceOf(
          agentConfig.rebalancerAddress,
        );
        if (balance.lt(amount)) {
          return textResult(
            `Insufficient wallet inventory for ${params.source}: ${balance.toString()} < ${params.amount}`,
          );
        }

        // Same-chain: direct transfer to warp token (instant)
        if (src.chain === dst.chain) {
          const tx = await token.transfer(dst.warpToken, amount);
          const receipt = await tx.wait();

          return textResult(
            JSON.stringify({
              status: 'ok',
              action: 'supply_collateral',
              source: params.source,
              destination: params.destination,
              amount: params.amount,
              delivery: 'instant',
              txHash: receipt.transactionHash,
            }),
          );
        }

        // Cross-chain: approve bridge + transferRemote
        if (!src.bridge || src.bridge === ethers.constants.AddressZero) {
          return textResult(
            `No bridge for cross-chain supply from ${params.source}. Need bridge or use an inventory bridge to move tokens first.`,
          );
        }

        // Approve bridge to pull tokens
        const approveTx = await token.approve(src.bridge, amount);
        await approveTx.wait();

        // transferRemote with dest warp token as recipient
        const destWarpBytes32 = ethers.utils.hexZeroPad(dst.warpToken, 32);
        const bridge = new ethers.Contract(
          src.bridge,
          BRIDGE_TRANSFER_REMOTE_ABI,
          wallet,
        );
        const tx = await bridge.transferRemote(
          dst.domainId,
          destWarpBytes32,
          amount,
        );
        const receipt = await tx.wait();
        const messageId = extractMessageId(receipt);

        return textResult(
          JSON.stringify({
            status: 'ok',
            action: 'supply_collateral',
            source: params.source,
            destination: params.destination,
            amount: params.amount,
            delivery: 'pending',
            messageId,
            txHash: receipt.transactionHash,
          }),
        );
      } catch (error) {
        return textResult(
          `supply_collateral failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
