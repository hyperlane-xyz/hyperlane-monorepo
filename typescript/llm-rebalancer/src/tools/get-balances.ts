/**
 * get_balances tool — reads warp route collateral balances via ethers.
 */

import { Type, type Static } from '@sinclair/typebox';
import { ethers } from 'ethers';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { ChainConfig, RebalancerAgentConfig } from '../config.js';
import type { PendingTransferProvider } from '../pending-transfers.js';

const parameters = Type.Object({
  chains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Chain names to query. Defaults to all configured chains.',
    }),
  ),
});

type Params = Static<typeof parameters>;

const ERC20_BALANCE_OF = ['function balanceOf(address) view returns (uint256)'];

interface ChainBalance {
  balance: string;
  share: string;
  assets?: Record<string, { balance: string; share: string }>;
}

function getProvider(rpcUrl: string): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(rpcUrl);
}

async function getBalance(
  provider: ethers.providers.JsonRpcProvider,
  collateralToken: string,
  warpToken: string,
): Promise<ethers.BigNumber> {
  const erc20 = new ethers.Contract(collateralToken, ERC20_BALANCE_OF, provider);
  return erc20.balanceOf(warpToken);
}

export function buildGetBalancesTool(
  agentConfig: RebalancerAgentConfig,
  pendingTransferProvider?: PendingTransferProvider,
): ToolDefinition<typeof parameters> {
  return {
    name: 'get_balances',
    label: 'Get Balances',
    description:
      'Get current collateral balances AND pending user transfers. ' +
      'Returns balance per chain/asset with share percentages, plus any inflight transfers awaiting delivery. ' +
      'If pendingUserTransfers is non-empty, check that destination chains have enough collateral for the destination asset.',
    parameters,
    async execute(_toolCallId: string, params: Params) {
      try {
      const chainNames = params.chains ?? Object.keys(agentConfig.chains);

      // Detect multi-asset deployment
      const isMultiAsset = Object.values(agentConfig.chains).some((c) => c.assets);

      if (isMultiAsset) {
        // Multi-asset: each asset is an independent liquidity pool with its own total
        const assetBalances: Record<string, Record<string, ethers.BigNumber>> = {};
        const assetDecimals: Record<string, number> = {};

        await Promise.all(
          chainNames.map(async (chainName: string) => {
            const chain: ChainConfig | undefined = agentConfig.chains[chainName];
            if (!chain?.assets) return;

            const provider = getProvider(chain.rpcUrl);
            await Promise.all(
              Object.entries(chain.assets).map(async ([symbol, asset]) => {
                if (!assetBalances[symbol]) assetBalances[symbol] = {};
                if (!assetDecimals[symbol]) assetDecimals[symbol] = asset.decimals;
                assetBalances[symbol][chainName] = await getBalance(provider, asset.collateralToken, asset.warpToken);
              }),
            );
          }),
        );

        // Build per-asset output with independent totals
        const assets: Record<string, { totalBalance: string; decimals: number; chains: Record<string, { balance: string; formatted: string; share: string }> }> = {};
        for (const [symbol, chainBals] of Object.entries(assetBalances)) {
          let assetTotal = ethers.BigNumber.from(0);
          const decimals = assetDecimals[symbol] ?? 18;
          for (const bal of Object.values(chainBals)) {
            assetTotal = assetTotal.add(bal);
          }
          const chains: Record<string, { balance: string; formatted: string; share: string }> = {};
          for (const chainName of chainNames) {
            const bal = chainBals[chainName];
            if (!bal) continue;
            chains[chainName] = {
              balance: bal.toString(),
              formatted: ethers.utils.formatUnits(bal, decimals) + ' ' + symbol,
              share: assetTotal.isZero()
                ? 'N/A (depleted)'
                : bal.mul(10000).div(assetTotal).toNumber() / 100 + '%',
            };
          }
          assets[symbol] = {
            totalBalance: assetTotal.toString(),
            decimals,
            ...(assetTotal.isZero() ? { status: 'DEPLETED — swap from another asset to create collateral' } : {}),
            chains,
          };
        }

        // Include pending transfers so LLM always sees them
        const pending = pendingTransferProvider
          ? await pendingTransferProvider.getPendingTransfers()
          : [];
        const output: any = { assets };
        if (pending.length > 0) {
          output.pendingUserTransfers = pending;
          output.WARNING = `${pending.length} user transfer(s) awaiting delivery — check destination asset collateral is sufficient`;
        }

        const text = JSON.stringify(output, null, 2);
        return { content: [{ type: 'text' as const, text }], details: undefined };
      }

      // Single-asset: original behavior
      const results: Record<string, ChainBalance> = {};
      const balances: Record<string, ethers.BigNumber> = {};

      await Promise.all(
        chainNames.map(async (chainName: string) => {
          const chain: ChainConfig | undefined = agentConfig.chains[chainName];
          if (!chain) return;
          const provider = getProvider(chain.rpcUrl);
          balances[chainName] = await getBalance(provider, chain.collateralToken, chain.warpToken);
        }),
      );

      let totalBalance = ethers.BigNumber.from(0);
      for (const bal of Object.values(balances)) {
        totalBalance = totalBalance.add(bal);
      }

      for (const chainName of chainNames) {
        const bal = balances[chainName];
        if (!bal) continue;

        const share = totalBalance.isZero()
          ? '0'
          : bal.mul(10000).div(totalBalance).toNumber() / 100 + '%';

        results[chainName] = { balance: bal.toString(), share };
      }

      // Include pending transfers so LLM always sees them
      const pending = pendingTransferProvider
        ? await pendingTransferProvider.getPendingTransfers()
        : [];
      const output: any = { totalBalance: totalBalance.toString(), chains: results };
      if (pending.length > 0) {
        output.pendingUserTransfers = pending;
        output.WARNING = `${pending.length} user transfer(s) awaiting delivery — check destination collateral is sufficient`;
      }

      const text = JSON.stringify(output, null, 2);
      return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (error) {
        const text = `Error fetching balances: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: 'text' as const, text }], details: undefined };
      }
    },
  };
}
