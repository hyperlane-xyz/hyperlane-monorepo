/**
 * get_balances tool — reads warp route collateral balances via ethers.
 */

import { Type, type Static } from '@sinclair/typebox';
import { ethers } from 'ethers';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { ChainConfig, RebalancerAgentConfig } from '../config.js';

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
): ToolDefinition<typeof parameters> {
  return {
    name: 'get_balances',
    label: 'Get Balances',
    description:
      'Get current collateral balances for warp route chains. ' +
      'Returns balance per chain/asset with share percentages.',
    parameters,
    async execute(_toolCallId: string, params: Params) {
      try {
      const chainNames = params.chains ?? Object.keys(agentConfig.chains);
      const results: Record<string, ChainBalance> = {};

      // Collect balances concurrently
      const balances: Record<string, ethers.BigNumber> = {};
      const assetBalances: Record<string, Record<string, ethers.BigNumber>> = {};

      await Promise.all(
        chainNames.map(async (chainName: string) => {
          const chain: ChainConfig | undefined = agentConfig.chains[chainName];
          if (!chain) return;

          const provider = getProvider(chain.rpcUrl);
          balances[chainName] = await getBalance(provider, chain.collateralToken, chain.warpToken);

          if (chain.assets) {
            assetBalances[chainName] = {};
            await Promise.all(
              Object.entries(chain.assets).map(async ([symbol, asset]) => {
                assetBalances[chainName][symbol] = await getBalance(provider, asset.collateralToken, asset.warpToken);
              }),
            );
          }
        }),
      );

      // Sum sequentially after all fetches complete
      let totalBalance = ethers.BigNumber.from(0);
      for (const bal of Object.values(balances)) {
        totalBalance = totalBalance.add(bal);
      }

      // Build results with shares
      for (const chainName of chainNames) {
        const bal = balances[chainName];
        if (!bal) continue;

        const share = totalBalance.isZero()
          ? '0'
          : bal.mul(10000).div(totalBalance).toNumber() / 100 + '%';

        const chainResult: ChainBalance = {
          balance: bal.toString(),
          share,
        };

        if (assetBalances[chainName]) {
          chainResult.assets = {};
          for (const [symbol, assetBal] of Object.entries(assetBalances[chainName])) {
            chainResult.assets[symbol] = {
              balance: assetBal.toString(),
              share: totalBalance.isZero()
                ? '0'
                : assetBal.mul(10000).div(totalBalance).toNumber() / 100 + '%',
            };
          }
        }

        results[chainName] = chainResult;
      }

      const text = JSON.stringify({ totalBalance: totalBalance.toString(), chains: results }, null, 2);
      return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (error) {
        const text = `Error fetching balances: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: 'text' as const, text }], details: undefined };
      }
    },
  };
}
