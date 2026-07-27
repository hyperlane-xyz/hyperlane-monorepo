import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';

const deploymentChains = ['ethereum', 'arbitrum', 'plasma', 'polygon'] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

const lzEids: Record<DeploymentChain, number> = {
  ethereum: 30101,
  arbitrum: 30110,
  plasma: 30383,
  polygon: 30109,
};

const oftAddresses: Record<DeploymentChain, string> = {
  ethereum: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee', // Official Ethereum Lock/Unlock Adapter
  arbitrum: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92', // Arbitrum Interoperability Proxy
  plasma: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9', // Plasma Network Native OFT Root
  polygon: '0x6ba10300f0dc58b7a1e4c0e41f5dabb7d7829e13', // Polygon OFT Adapter
};

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  // arbitrum stays inline until awIcas.arbitrum is exported again in aw.ts
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45',
  plasma: awIcas.plasma,
  polygon: awIcas.polygon,
};

export const getUSDTOftWarpConfig = async (
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
