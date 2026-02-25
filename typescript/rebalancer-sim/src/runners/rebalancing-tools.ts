/**
 * Structured rebalancing tools — encapsulate on-chain mechanics so the LLM
 * never needs to construct raw transactions, encode bytes32, or manage approvals.
 *
 * Two ossified operations:
 * 1. rebalance_collateral — router→router via MovableCollateralRouter.rebalance()
 * 2. supply_collateral — wallet→router (same-chain: instant, cross-chain: via bridge)
 *
 * Variable operations (inventory bridges like LiFi, CCTP) remain as skills.
 */

import { ethers } from 'ethers';

import type { RebalancerAgentConfig } from '@hyperlane-xyz/llm-rebalancer';

import type { KPICollector } from '../KPICollector.js';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256)',
  'function transfer(address, uint256) returns (bool)',
];

const WARP_REBALANCE_ABI = ['function rebalance(uint32, uint256, address)'];

const BRIDGE_TRANSFER_REMOTE_ABI = [
  'function transferRemote(uint32, bytes32, uint256) returns (bytes32)',
];

/** DispatchId event topic — emitted by Mailbox on dispatch */
const DISPATCH_ID_TOPIC =
  '0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a';

// ---------------------------------------------------------------------------
// Node resolution
// ---------------------------------------------------------------------------

interface ResolvedNode {
  chain: string;
  symbol?: string;
  rpcUrl: string;
  domainId: number;
  warpToken: string;
  collateralToken: string;
  bridge: string;
}

/**
 * Parse a node ID ("SYMBOL|chain" or "chain") and resolve addresses from config.
 */
function resolveNode(
  agentConfig: RebalancerAgentConfig,
  nodeId: string,
): ResolvedNode {
  const pipe = nodeId.indexOf('|');
  if (pipe >= 0) {
    const symbol = nodeId.slice(0, pipe);
    const chain = nodeId.slice(pipe + 1);
    const chainCfg = agentConfig.chains[chain];
    if (!chainCfg)
      throw new Error(`Unknown chain "${chain}" in node "${nodeId}"`);
    if (!chainCfg.assets?.[symbol]) {
      throw new Error(`Unknown asset "${symbol}" on chain "${chain}"`);
    }
    const asset = chainCfg.assets[symbol];
    return {
      chain,
      symbol,
      rpcUrl: chainCfg.rpcUrl,
      domainId: chainCfg.domainId,
      warpToken: asset.warpToken,
      collateralToken: asset.collateralToken,
      bridge: asset.bridge,
    };
  }
  const chain = nodeId;
  const chainCfg = agentConfig.chains[chain];
  if (!chainCfg) throw new Error(`Unknown chain "${chain}"`);
  return {
    chain,
    rpcUrl: chainCfg.rpcUrl,
    domainId: chainCfg.domainId,
    warpToken: chainCfg.warpToken,
    collateralToken: chainCfg.collateralToken,
    bridge: chainCfg.bridge,
  };
}

function extractMessageId(
  receipt: ethers.providers.TransactionReceipt,
): string | null {
  for (const log of receipt.logs) {
    if (log.topics[0] === DISPATCH_ID_TOPIC && log.topics.length > 1) {
      return log.topics[1];
    }
  }
  return null;
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

// ---------------------------------------------------------------------------
// Tool 1: rebalance_collateral
// ---------------------------------------------------------------------------

/**
 * Direct router→router collateral movement via MovableCollateralRouter.rebalance().
 * Same-asset, cross-chain only. Preferred for distribution imbalances.
 */
export function buildRebalanceCollateralTool(
  agentConfig: RebalancerAgentConfig,
): any {
  return {
    name: 'rebalance_collateral',
    label: 'Rebalance Collateral',
    description:
      'Move router collateral directly from one chain to another (same-asset, cross-chain). ' +
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
        amount: { type: 'string', description: 'Amount in wei' },
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

// ---------------------------------------------------------------------------
// Tool 2: supply_collateral
// ---------------------------------------------------------------------------

/**
 * Supply collateral to a router from the rebalancer's wallet inventory.
 * Same-asset only. Same-chain is instant; cross-chain goes through bridge.
 */
// ---------------------------------------------------------------------------
// Tool 3: mock_lifi_swap (sim-only inventory bridge)
// ---------------------------------------------------------------------------

const BURN_FROM_ABI = ['function burnFrom(address, uint256)'];
const MINT_TO_ABI = ['function mintTo(address, uint256)'];

/**
 * Mock LiFi/DEX swap — converts one asset to another in the rebalancer's wallet.
 * Sim-only: uses ERC20Test.burnFrom() + mintTo() (both public, no access control).
 * In production, this would be a skill calling the LiFi API.
 */
export function buildMockLifiSwapTool(
  agentConfig: RebalancerAgentConfig,
  kpiCollector?: KPICollector,
): any {
  return {
    name: 'mock_lifi_swap',
    label: 'Mock LiFi Swap',
    description:
      'Inventory bridge: swap tokens in your wallet from one asset to another on the same chain. ' +
      'Simulates LiFi/DEX. 1:1 stablecoin rate. Same-chain only. ' +
      'Use when you need asset X but only have asset Y in wallet. ' +
      'After swapping, use supply_collateral to deposit into a router.',
    parameters: {
      type: 'object',
      required: ['chain', 'sourceAsset', 'destinationAsset', 'amount'],
      properties: {
        chain: { type: 'string', description: 'Chain name' },
        sourceAsset: {
          type: 'string',
          description: 'Source asset symbol to sell (e.g., USDC)',
        },
        destinationAsset: {
          type: 'string',
          description: 'Destination asset symbol to buy (e.g., USDT)',
        },
        amount: { type: 'string', description: 'Amount in wei' },
      },
    },
    async execute(
      _toolCallId: string,
      params: {
        chain: string;
        sourceAsset: string;
        destinationAsset: string;
        amount: string;
      },
    ) {
      try {
        const chainCfg = agentConfig.chains[params.chain];
        if (!chainCfg) throw new Error(`Unknown chain "${params.chain}"`);
        if (!chainCfg.assets)
          throw new Error(`No multi-asset config for chain "${params.chain}"`);
        if (params.sourceAsset === params.destinationAsset) {
          return textResult(
            `mock_lifi_swap: source and destination are the same asset (${params.sourceAsset}). No swap needed.`,
          );
        }

        const srcAsset = chainCfg.assets[params.sourceAsset];
        const dstAsset = chainCfg.assets[params.destinationAsset];
        if (!srcAsset)
          throw new Error(
            `Unknown asset "${params.sourceAsset}" on ${params.chain}`,
          );
        if (!dstAsset)
          throw new Error(
            `Unknown asset "${params.destinationAsset}" on ${params.chain}`,
          );

        const amount = ethers.BigNumber.from(params.amount);
        const provider = new ethers.providers.JsonRpcProvider(chainCfg.rpcUrl);
        const wallet = new ethers.Wallet(agentConfig.rebalancerKey, provider);

        // Check source balance
        const srcToken = new ethers.Contract(
          srcAsset.collateralToken,
          [...ERC20_ABI, ...BURN_FROM_ABI],
          wallet,
        );
        const balance: ethers.BigNumber = await srcToken.balanceOf(
          agentConfig.rebalancerAddress,
        );
        if (balance.lt(amount)) {
          return textResult(
            `Insufficient ${params.sourceAsset} wallet balance on ${params.chain}: ${balance.toString()} < ${params.amount}`,
          );
        }

        // Burn source tokens from rebalancer wallet
        const burnTx = await srcToken.burnFrom(
          agentConfig.rebalancerAddress,
          amount,
        );
        await burnTx.wait();

        // Mint destination tokens to rebalancer wallet
        const dstToken = new ethers.Contract(
          dstAsset.collateralToken,
          MINT_TO_ABI,
          wallet,
        );
        const mintTx = await dstToken.mintTo(
          agentConfig.rebalancerAddress,
          amount,
        );
        await mintTx.wait();

        // Record KPI (instant, same-chain)
        if (kpiCollector) {
          const rid = kpiCollector.recordRebalanceStart(
            params.chain,
            params.chain,
            amount.toBigInt(),
            0n,
            `${params.sourceAsset}→${params.destinationAsset}`,
          );
          const syntheticId = `swap-${Date.now()}`;
          kpiCollector.linkBridgeTransfer(syntheticId, rid);
          kpiCollector.recordRebalanceComplete(syntheticId);
        }

        return textResult(
          JSON.stringify({
            status: 'ok',
            action: 'mock_lifi_swap',
            chain: params.chain,
            sourceAsset: params.sourceAsset,
            destinationAsset: params.destinationAsset,
            amount: params.amount,
            delivery: 'instant',
          }),
        );
      } catch (error) {
        return textResult(
          `mock_lifi_swap failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: supply_collateral
// ---------------------------------------------------------------------------

export function buildSupplyCollateralTool(
  agentConfig: RebalancerAgentConfig,
  kpiCollector?: KPICollector,
): any {
  return {
    name: 'supply_collateral',
    label: 'Supply Collateral',
    description:
      'Supply collateral to a router from your wallet inventory (same-asset). ' +
      'Same-chain: instant. Cross-chain: via bridge (has delivery delay). ' +
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
        amount: { type: 'string', description: 'Amount in wei' },
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
          await tx.wait();

          // Record KPI (instant completion)
          if (kpiCollector) {
            const rid = kpiCollector.recordRebalanceStart(
              src.chain,
              dst.chain,
              amount.toBigInt(),
              0n,
              src.symbol,
            );
            const syntheticId = `supply-${Date.now()}`;
            kpiCollector.linkBridgeTransfer(syntheticId, rid);
            kpiCollector.recordRebalanceComplete(syntheticId);
          }

          return textResult(
            JSON.stringify({
              status: 'ok',
              action: 'supply_collateral',
              source: params.source,
              destination: params.destination,
              amount: params.amount,
              delivery: 'instant',
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

        // KPI tracked by MockInfrastructureController via Dispatch event

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
