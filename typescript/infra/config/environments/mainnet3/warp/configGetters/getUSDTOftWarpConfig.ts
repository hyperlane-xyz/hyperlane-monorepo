import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { awSafes } from '../../governance/safe/aw.js';
import { awIcas } from '../../governance/ica/aw.js';

const deploymentChains = ['ethereum', 'arbitrum', 'plasma'] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

const lzEids: Record<DeploymentChain, number> = {
  ethereum: 30101,
  arbitrum: 30110,
  plasma: 30383,
};

const oftAddresses: Record<DeploymentChain, string> = {
  ethereum: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee',
  arbitrum: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92',
  plasma: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9',
};

// const ownersByChain: Record<DeploymentChain, string> = {
//   'arbitrum': awIcas.arbitrum,
//   'ethereum': awSafes.ethereum,
//   'plasma':  awIcas.plasma
// }

const deployerAddress = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5';

export const getUSDTOftWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  Object.fromEntries(
    deploymentChains.map((chain) => [
      chain,
      {
        ...routerConfig[chain],
        owner: deployerAddress,
        type: TokenType.collateralOft,
        token: tokens[chain as keyof typeof tokens as DeploymentChain].USDT,
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
