import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';

const deploymentChains = ['ethereum', 'arbitrum', 'tron'] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

const lzEids: Record<DeploymentChain, number> = {
  ethereum: 30101,
  arbitrum: 30110,
  tron: 30420,
};

const oftAddresses: Record<DeploymentChain, string> = {
  ethereum: '0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0',
  arbitrum: '0x77652D5aba086137b595875263FC200182919B92',
  tron: '0x3a08f76772e200653bb55c2a92998daca62e0e97',
};

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  // arbitrum stays inline until awIcas.arbitrum is exported again in aw.ts
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45',
  tron: awIcas.tron,
};

export const getUSDTOftLegacyWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  Object.fromEntries(
    deploymentChains.map((chain) => [
      chain,
      {
        ...routerConfig[chain],
        owner: ownersByChain[chain],
        type: TokenType.collateralOft,
        token: tokens[chain].USDT,
        oft: oftAddresses[chain],
        decimals: 6,
        name: 'Tether USD',
        symbol: 'USDT',
        domainMappings: Object.fromEntries(
          Object.entries(lzEids).filter(([c]) => c !== chain),
        ),
        extraOptions: '0x',
      },
    ]),
  );
