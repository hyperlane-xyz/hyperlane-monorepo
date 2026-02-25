/**
 * Custom tool factory — builds typed Pi tools for the rebalancer agent.
 */

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { RebalancerAgentConfig } from '../config.js';
import type { ContextStore } from '../context-store.js';
import type { PendingTransferProvider } from '../pending-transfers.js';
import { buildGetBalancesTool } from './get-balances.js';
import { buildGetChainMetadataTool } from './get-chain-metadata.js';
import { buildCheckDeliveryTool } from './check-hyperlane-delivery.js';
import { buildGetInventoryTool } from './get-inventory.js';
import { buildGetPendingTransfersTool } from './get-pending-transfers.js';
import { buildRebalanceCollateralTool } from './rebalance-collateral.js';
import { buildSaveContextTool } from './save-context.js';
import { buildSupplyCollateralTool } from './supply-collateral.js';

export function buildCustomTools(
  agentConfig: RebalancerAgentConfig,
  contextStore: ContextStore,
  routeId: string,
  pendingTransferProvider?: PendingTransferProvider,
): ToolDefinition<any>[] {
  const tools: ToolDefinition<any>[] = [
    buildGetBalancesTool(agentConfig, pendingTransferProvider),
    buildGetInventoryTool(agentConfig),
    buildGetChainMetadataTool(agentConfig),
    buildCheckDeliveryTool(agentConfig),
    buildSaveContextTool(contextStore, routeId, pendingTransferProvider),
    buildRebalanceCollateralTool(agentConfig),
    buildSupplyCollateralTool(agentConfig),
  ];

  if (pendingTransferProvider) {
    tools.push(buildGetPendingTransfersTool(pendingTransferProvider));
  }

  return tools;
}
