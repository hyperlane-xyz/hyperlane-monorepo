import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';

// USDT0 deployment docs: https://docs.usdt0.to/technical-documentation/deployments
const deploymentChains = [
  'ethereum',
  'arbitrum',
  'plasma',
  'polygon',
  'optimism',
  'mantle',
  'monad',
] as const;

export type DeploymentChain = (typeof deploymentChains)[number];

// LayerZero V2 endpoint IDs: https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts
const lzEids: Record<DeploymentChain, number> = {
  ethereum: 30101,
  arbitrum: 30110,
  plasma: 30383,
  polygon: 30109,
  optimism: 30111,
  mantle: 30181,
  monad: 30390,
};

// OFT/OFT Adapter addresses from https://docs.usdt0.to/technical-documentation/deployments
const oftAddresses: Record<DeploymentChain, string> = {
  ethereum: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee',
  arbitrum: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92',
  plasma: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9',
  polygon: '0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13',
  optimism: '0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD',
  mantle: '0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC',
  monad: '0x9151434b16b9763660705744891fA906F660EcC5',
};

// USDT0 is a separate token from original USDT on optimism, mantle, and monad.
// On ethereum, arbitrum, plasma, and polygon the original USDT was upgraded in-place.
const tokenAddresses: Record<DeploymentChain, string> = {
  ethereum: tokens.ethereum.USDT,
  arbitrum: tokens.arbitrum.USDT,
  plasma: tokens.plasma.USDT,
  polygon: tokens.polygon.USDT,
  optimism: tokens.optimism.USDT0,
  mantle: tokens.mantle.USDT0,
  monad: tokens.monad.USDT0,
};

const ownersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum,
  // arbitrum stays inline until awIcas.arbitrum is exported again in aw.ts
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45',
  plasma: awIcas.plasma,
  polygon: awIcas.polygon,
  // optimism stays inline until awIcas.optimism is exported again in aw.ts
  optimism: '0x1E2afA8d1B841c53eDe9474D188Cd4FcfEd40dDC',
  mantle: awIcas.mantle,
  monad: awIcas.monad,
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
        token: tokenAddresses[chain],
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
