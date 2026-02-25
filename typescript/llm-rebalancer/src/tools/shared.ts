/**
 * Shared utilities for rebalancing tools.
 */

import { ethers } from 'ethers';

import type { RebalancerAgentConfig } from '../config.js';

export interface ResolvedNode {
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
export function resolveNode(
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

/** DispatchId event topic — emitted by Mailbox on dispatch */
const DISPATCH_ID_TOPIC =
  '0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a';

export function extractMessageId(
  receipt: ethers.providers.TransactionReceipt,
): string | null {
  for (const log of receipt.logs) {
    if (log.topics[0] === DISPATCH_ID_TOPIC && log.topics.length > 1) {
      return log.topics[1];
    }
  }
  return null;
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}
