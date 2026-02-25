/**
 * supply_collateral — increase router collateral from rebalancer wallet inventory.
 *
 * Two execution modes:
 *
 * 1. **Reverse rebalance** (destination provided, cross-chain):
 *    Calls transferRemote FROM the deficit chain. Tokens are locked as collateral on source,
 *    released to rebalancer on the surplus destination. Net inventory preserved.
 *
 * 2. **Direct deposit** (no destination, or asset is globally depleted):
 *    Transfers tokens directly to the source router contract. Increases collateral on source.
 *    Rebalancer wallet inventory decreases — use only when the asset is depleted system-wide.
 *
 * For multi-collateral with multiple assets on the destination, uses transferRemoteTo
 * with an explicit target router.
 */

import { ethers } from 'ethers';

import type { RebalancerAgentConfig } from '../config.js';

import { resolveNode, extractMessageId, textResult } from './shared.js';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256)',
  'function transfer(address, uint256) returns (bool)',
];

const WARP_TOKEN_ABI = [
  'function transferRemote(uint32, bytes32, uint256) payable returns (bytes32)',
  'function transferRemoteTo(uint32, bytes32, uint256, bytes32) payable returns (bytes32)',
  'function quoteGasPayment(uint32) view returns (uint256)',
];

export function buildSupplyCollateralTool(
  agentConfig: RebalancerAgentConfig,
): any {
  return {
    name: 'supply_collateral',
    label: 'Supply Collateral',
    description:
      'Increase collateral on the source (deficit) chain using rebalancer wallet inventory. ' +
      'Two modes: (1) With destination — reverse rebalance via transferRemote (inventory preserved, ' +
      'collateral moves from destination to source). (2) Without destination — direct deposit to ' +
      'source router (inventory decreases, use for globally depleted assets). ' +
      'Node IDs: "USDC|chain1" (multi-asset) or "chain1" (single-asset).',
    parameters: {
      type: 'object',
      required: ['source', 'amount'],
      properties: {
        source: {
          type: 'string',
          description:
            'Deficit node ID — chain where collateral should INCREASE. ' +
            'Rebalancer must have inventory here.',
        },
        destination: {
          type: 'string',
          description:
            'Optional surplus node ID — chain where collateral will DECREASE and rebalancer receives tokens. ' +
            'Omit for direct deposit (globally depleted assets).',
        },
        amount: { type: 'string', description: 'Amount in smallest unit' },
      },
    },
    async execute(
      _toolCallId: string,
      params: { source: string; destination?: string; amount: string },
    ) {
      try {
        const src = resolveNode(agentConfig, params.source);
        const provider = new ethers.providers.JsonRpcProvider(src.rpcUrl);
        const wallet = new ethers.Wallet(agentConfig.rebalancerKey, provider);
        const requested = ethers.BigNumber.from(params.amount);

        // Check rebalancer inventory on source chain
        const token = new ethers.Contract(
          src.collateralToken,
          ERC20_ABI,
          wallet,
        );
        const sourceInventory: ethers.BigNumber = await token.balanceOf(
          agentConfig.rebalancerAddress,
        );
        if (sourceInventory.isZero()) {
          return textResult(
            `No inventory on ${params.source}. Use inventory bridge to move tokens here first.`,
          );
        }

        // Cap to available inventory
        let effective = requested.gt(sourceInventory)
          ? sourceInventory
          : requested;

        // --- Mode 1: Direct deposit (no destination) ---
        if (!params.destination) {
          const tx = await token.transfer(src.warpToken, effective);
          const receipt = await tx.wait();
          return textResult(
            JSON.stringify({
              status: 'ok',
              action: 'supply_collateral',
              path: 'direct_deposit',
              source: params.source,
              effective: effective.toString(),
              capped: effective.lt(requested),
              txHash: receipt.transactionHash,
            }),
          );
        }

        // --- Mode 2: Reverse rebalance (with destination) ---
        const dst = resolveNode(agentConfig, params.destination);
        if (src.chain === dst.chain) {
          // Same chain with destination = treat as direct deposit
          const tx = await token.transfer(src.warpToken, effective);
          const receipt = await tx.wait();
          return textResult(
            JSON.stringify({
              status: 'ok',
              action: 'supply_collateral',
              path: 'direct_deposit',
              source: params.source,
              effective: effective.toString(),
              capped: effective.lt(requested),
              txHash: receipt.transactionHash,
            }),
          );
        }

        // Check destination router collateral (can't withdraw more than exists)
        const dstProvider = new ethers.providers.JsonRpcProvider(dst.rpcUrl);
        const dstCollateralToken = new ethers.Contract(
          dst.collateralToken,
          ERC20_ABI,
          dstProvider,
        );
        const destRouterCollateral: ethers.BigNumber =
          await dstCollateralToken.balanceOf(dst.warpToken);

        // If destination has no collateral, fall back to direct deposit
        if (destRouterCollateral.isZero()) {
          const tx = await token.transfer(src.warpToken, effective);
          const receipt = await tx.wait();
          return textResult(
            JSON.stringify({
              status: 'ok',
              action: 'supply_collateral',
              path: 'direct_deposit_fallback',
              source: params.source,
              destination: params.destination,
              reason: 'destination router has 0 collateral',
              effective: effective.toString(),
              capped: effective.lt(requested),
              txHash: receipt.transactionHash,
            }),
          );
        }

        // Cap to destination router collateral
        let capped = effective.lt(requested);
        if (effective.gt(destRouterCollateral)) {
          effective = destRouterCollateral;
          capped = true;
        }

        // Approve source warp token to spend collateral
        const currentAllowance: ethers.BigNumber = await token.allowance(
          agentConfig.rebalancerAddress,
          src.warpToken,
        );
        if (currentAllowance.lt(effective)) {
          const approveTx = await token.approve(src.warpToken, effective);
          await approveTx.wait();
        }

        // Quote gas payment
        const warp = new ethers.Contract(
          src.warpToken,
          WARP_TOKEN_ABI,
          wallet,
        );
        const gasQuote: ethers.BigNumber = await warp.quoteGasPayment(
          dst.domainId,
        );

        // Recipient = rebalancer's own address (inventory preserved)
        const recipientBytes32 = ethers.utils.hexZeroPad(
          agentConfig.rebalancerAddress,
          32,
        );

        // Determine if we need transferRemoteTo (multi-asset on destination)
        const dstChainConfig = agentConfig.chains[dst.chain];
        const needsExplicitRouter =
          dstChainConfig?.assets &&
          Object.keys(dstChainConfig.assets).length > 1;

        let tx: ethers.ContractTransaction;
        let path: string;
        if (needsExplicitRouter) {
          const targetRouterBytes32 = ethers.utils.hexZeroPad(
            dst.warpToken,
            32,
          );
          tx = await warp.transferRemoteTo(
            dst.domainId,
            recipientBytes32,
            effective,
            targetRouterBytes32,
            { value: gasQuote },
          );
          path = 'transferRemoteTo';
        } else {
          tx = await warp.transferRemote(
            dst.domainId,
            recipientBytes32,
            effective,
            { value: gasQuote },
          );
          path = 'transferRemote';
        }

        const receipt = await tx.wait();
        const messageId = extractMessageId(receipt);

        return textResult(
          JSON.stringify({
            status: 'ok',
            action: 'supply_collateral',
            path,
            source: params.source,
            destination: params.destination,
            requested: requested.toString(),
            effective: effective.toString(),
            capped,
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
