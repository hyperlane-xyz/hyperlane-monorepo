import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

const safeOwners: Record<string, string> = {
  arbitrum: '0xc8A9Dea7359Bd6FDCAD3B8EDE108416C25cF4CE9',
  avalanche: '0x6d5Cd9e6EB9a2E74bF9857c53aA44F659f0Cc332',
  base: '0xcEC53d6fF9B4C7b8E77f0C0D3f8828Bb872f2377',
  bsc: '0xa86C4AF592ddAa676f53De278dE9cfCD52Ae6B39',
  ethereum: '0xa86C4AF592ddAa676f53De278dE9cfCD52Ae6B39',
  lumiaprism: '0xa86C4AF592ddAa676f53De278dE9cfCD52Ae6B39',
  optimism: '0x914931eBb5638108651455F50C1F784d3E5fd3EC',
  polygon: '0x7a412dD3812369226cd42023FC9301A66788122e',
};

export const getArbitrumAvalancheBaseBscEthereumLumiaprismOptimismPolygonLUMIAWarpConfig =
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    const arbitrum: HypTokenRouterConfig = {
      ...routerConfig.arbitrum,
      owner: safeOwners.arbitrum,
      type: TokenType.synthetic,
      symbol: 'LUMIA',
    };

    const avalanche: HypTokenRouterConfig = {
      ...routerConfig.avalanche,
      owner: safeOwners.avalanche,
      type: TokenType.synthetic,
      symbol: 'LUMIA',
    };

    const base: HypTokenRouterConfig = {
      ...routerConfig.base,
      owner: safeOwners.base,
      type: TokenType.synthetic,
      symbol: 'LUMIA',
    };

    const bsc: HypTokenRouterConfig = {
      ...routerConfig.bsc,
      owner: safeOwners.bsc,
      type: TokenType.synthetic,
      proxyAdmin: {
        address: '0x54bB5b12c67095eB3dabCD11FA74AAcfE46E7767',
        owner: '0x8bBA07Ddc72455b55530C17e6f6223EF6E156863',
      },
    };

    const ethereum: HypTokenRouterConfig = {
      ...routerConfig.ethereum,
      owner: safeOwners.ethereum,
      type: TokenType.collateral,
      token: '0xD9343a049D5DBd89CD19DC6BcA8c48fB3a0a42a7',
      proxyAdmin: {
        address: '0xdaB976ae358D4D2d25050b5A25f71520983C46c9',
        owner: '0x8bBA07Ddc72455b55530C17e6f6223EF6E156863',
      },
    };

    const lumiaprism: HypTokenRouterConfig = {
      ...routerConfig.lumiaprism,
      owner: safeOwners.lumiaprism,
      type: TokenType.native,
      proxyAdmin: {
        address: '0xBC53dACd8c0ac0d2bAC461479EAaf5519eCC8853',
        owner: '0x8bBA07Ddc72455b55530C17e6f6223EF6E156863',
      },
    };

    const optimism: HypTokenRouterConfig = {
      ...routerConfig.optimism,
      owner: safeOwners.optimism,
      type: TokenType.synthetic,
      symbol: 'LUMIA',
    };

    const polygon: HypTokenRouterConfig = {
      ...routerConfig.polygon,
      owner: safeOwners.polygon,
      type: TokenType.synthetic,
      symbol: 'LUMIA',
    };

    return {
      arbitrum,
      avalanche,
      base,
      bsc,
      ethereum,
      lumiaprism,
      optimism,
      polygon,
    };
  };

// Create a GnosisSafeBuilder Strategy for each safe address
export function getLUMIAGnosisSafeBuilderStrategyConfigGenerator(
  lumiaSafes: Record<string, string>,
) {
  return (): ChainSubmissionStrategy => {
    return Object.fromEntries(
      Object.entries(lumiaSafes).map(([chain, safeAddress]) => [
        chain,
        {
          submitter: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            version: '1.0',
            chain,
            safeAddress,
          },
        },
      ]),
    );
  };
}

export const getLUMIAGnosisSafeBuilderStrategyConfig =
  getLUMIAGnosisSafeBuilderStrategyConfigGenerator(safeOwners);
