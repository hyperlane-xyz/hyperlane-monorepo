/**
 * supply_collateral — inventory reverse rebalance via transferRemote.
 *
 * Calls transferRemote FROM the deficit chain (source), depositing collateral there.
 * Tokens are released to the rebalancer on the surplus chain (destination).
 * Net effect: source collateral ↑, destination collateral ↓, rebalancer inventory preserved.
 *
 * NEVER donates inventory. The rebalancer's total token holdings must remain constant.
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
    label: 'Supply Collateral (Inventory Reverse Rebalance)',
    description:
      'Increase collateral on the source (deficit) chain by calling transferRemote FROM it. ' +
      'Rebalancer tokens are deposited as collateral on source, then released to rebalancer on destination (surplus). ' +
      'Rebalancer inventory is preserved — tokens just move chains. NEVER donates inventory. ' +
      'Amount is capped to min(requested, sourceInventory, destRouterCollateral). ' +
      'Source and destination must be different chains. ' +
      'Node IDs: "USDC|chain1" (multi-asset) or "chain1" (single-asset).',
    parameters: {
      type: 'object',
      required: ['source', 'destination', 'amount'],
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
            'Surplus node ID — chain where collateral will DECREASE. ' +
            'Rebalancer receives tokens here.',
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

        if (src.chain === dst.chain) {
          return textResult(
            'supply_collateral requires different chains. ' +
              'Cannot reverse-rebalance within the same chain.',
          );
        }

        const provider = new ethers.providers.JsonRpcProvider(src.rpcUrl);
        const wallet = new ethers.Wallet(agentConfig.rebalancerKey, provider);
        const requested = ethers.BigNumber.from(params.amount);

        // Check rebalancer inventory on source (deficit) chain
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

        // Check destination router collateral (can't withdraw more than exists)
        const dstProvider = new ethers.providers.JsonRpcProvider(dst.rpcUrl);
        const dstCollateralToken = new ethers.Contract(
          dst.collateralToken,
          ERC20_ABI,
          dstProvider,
        );
        const destRouterCollateral: ethers.BigNumber =
          await dstCollateralToken.balanceOf(dst.warpToken);

        if (destRouterCollateral.isZero()) {
          return textResult(
            JSON.stringify({
              status: 'error',
              error: 'destination_depleted',
              source: params.source,
              destination: params.destination,
              reason:
                'Destination router has 0 collateral — nothing to release to rebalancer. ' +
                'Use rebalance_collateral or inventory bridge instead.',
            }),
          );
        }

        // Cap to min(requested, sourceInventory, destRouterCollateral)
        let effective = requested;
        let capped = false;
        if (effective.gt(sourceInventory)) {
          effective = sourceInventory;
          capped = true;
        }
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
