import { CONTRACTS_PACKAGE_VERSION } from '@hyperlane-xyz/core';
import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { chainOwners } from '../../owners.js';

const deploymentChains = [
  'arbitrum',
  'base',
  'ethereum',
  'polygon',
  'unichain',
  'solanamainnet',
  'subtensor',
] as const;

type DeploymentChain = (typeof deploymentChains)[number];

const existingChains: DeploymentChain[] = [
  'base',
  'ethereum',
  'solanamainnet',
  'subtensor',
];

const syntethicChain: DeploymentChain = 'subtensor';

const usdcTokenAddresses: Record<DeploymentChain, string> = {
  arbitrum: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  solanamainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  subtensor: '',
};

export const getSubtensorUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const conf = Object.fromEntries(
    deploymentChains.map((chain): [DeploymentChain, HypTokenRouterConfig] => {
      const owner = awIcas[chain] ?? awSafes[chain] ?? chainOwners[chain].owner;

      if (chain === syntethicChain) {
        return [
          chain,
          {
            type: TokenType.synthetic,
            mailbox: routerConfig[chain].mailbox,
            owner,
          },
        ];
      }

      if (chain === 'solanamainnet') {
        return [
          chain,
          {
            type: TokenType.collateral,
            token: usdcTokenAddresses[chain],
            mailbox: routerConfig[chain].mailbox,
            foreignDeployment: 'GPCsiXvm9NaFjrxB6sThscap6akyvRgD5V6decCk25c',
            owner,
            gas: 300000,
          },
        ];
      }

      return [
        chain,
        {
          type: TokenType.collateral,
          token: usdcTokenAddresses[chain],
          mailbox: routerConfig[chain].mailbox,
          owner,
          contractVersion: existingChains.includes(chain)
            ? CONTRACTS_PACKAGE_VERSION
            : undefined,
        },
      ];
    }),
  );

  return conf;
};
