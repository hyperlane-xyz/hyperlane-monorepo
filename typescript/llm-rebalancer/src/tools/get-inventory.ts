/**
 * get_inventory tool — reads rebalancer wallet's own token balances per chain/asset.
 */

import { Type, type Static } from '@sinclair/typebox';
import { ethers } from 'ethers';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { RebalancerAgentConfig } from '../config.js';

const parameters = Type.Object({
  chains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Chain names to query. Defaults to all configured chains.',
    }),
  ),
});

type Params = Static<typeof parameters>;

const ERC20_BALANCE_OF = ['function balanceOf(address) view returns (uint256)'];

export function buildGetInventoryTool(
  agentConfig: RebalancerAgentConfig,
): ToolDefinition<typeof parameters> {
  return {
    name: 'get_inventory',
    label: 'Get Inventory',
    description:
      "Get rebalancer wallet's own token balances (not warp collateral). " +
      'Returns balance per chain/asset that the rebalancer can deposit or bridge.',
    parameters,
    async execute(_toolCallId: string, params: Params) {
      try {
        const chainNames = params.chains ?? Object.keys(agentConfig.chains);
        const results: Record<string, Record<string, string>> = {};

        await Promise.all(
          chainNames.map(async (chainName: string) => {
            const chain = agentConfig.chains[chainName];
            if (!chain) return;

            const provider = new ethers.providers.JsonRpcProvider(chain.rpcUrl);
            results[chainName] = {};

            if (chain.assets) {
              // Multi-asset: check each asset's collateral token
              await Promise.all(
                Object.entries(chain.assets).map(async ([symbol, asset]) => {
                  const erc20 = new ethers.Contract(
                    asset.collateralToken,
                    ERC20_BALANCE_OF,
                    provider,
                  );
                  const bal: ethers.BigNumber = await erc20.balanceOf(
                    agentConfig.rebalancerAddress,
                  );
                  results[chainName][symbol] = `${bal.toString()} (${ethers.utils.formatUnits(bal, asset.decimals)} ${symbol})`;
                }),
              );
            } else {
              // Single-asset: check the primary collateral token
              const erc20 = new ethers.Contract(
                chain.collateralToken,
                ERC20_BALANCE_OF,
                provider,
              );
              const bal: ethers.BigNumber = await erc20.balanceOf(
                agentConfig.rebalancerAddress,
              );
              results[chainName][chainName] = bal.toString();
            }
          }),
        );

        const text = JSON.stringify(results, null, 2);
        return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (error) {
        const text = `Error fetching inventory: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: 'text' as const, text }], details: undefined };
      }
    },
  };
}
