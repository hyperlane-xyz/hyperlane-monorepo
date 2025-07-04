import { CONTRACTS_PACKAGE_VERSION } from '@hyperlane-xyz/core';
import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { chainOwners } from '../../owners.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

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

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

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
  const registry = getRegistry();
  const mainnetCCTP = registry.getWarpRoute('USDC/mainnet-cctp');

  assert(mainnetCCTP, 'MainnetCCTP warp route not found');

  const cctpBridges = Object.fromEntries(
    mainnetCCTP.tokens.map(
      ({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected cctp bridge address to be defined on chain ${chainName}`,
        );

        return [chainName, addressOrDenom];
      },
    ),
  );

  return Object.fromEntries(
    deploymentChains.map(
      (currentChain): [DeploymentChain, HypTokenRouterConfig] => {
        const owner =
          awIcas[currentChain] ??
          awSafes[currentChain] ??
          chainOwners[currentChain].owner;

        if (currentChain === syntethicChain) {
          return [
            currentChain,
            {
              type: TokenType.synthetic,
              mailbox: routerConfig[currentChain].mailbox,
              owner,
            },
          ];
        }

        const usdcTokenAddress = usdcTokenAddresses[currentChain];
        assert(
          usdcTokenAddress,
          `USDC token address not found for chain ${currentChain}`,
        );

        if (currentChain === 'solanamainnet') {
          return [
            currentChain,
            {
              type: TokenType.collateral,
              token: usdcTokenAddress,
              mailbox: routerConfig[currentChain].mailbox,
              foreignDeployment: 'GPCsiXvm9NaFjrxB6sThscap6akyvRgD5V6decCk25c',
              owner,
              gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
            },
          ];
        }

        const cctpBridge = cctpBridges[currentChain];
        const allowedRebalancingBridges = Object.fromEntries(
          deploymentChains
            .filter(
              (remoteChain) =>
                remoteChain !== currentChain && remoteChain !== 'solanamainnet',
            )
            .map((remoteChain) => [remoteChain, [{ bridge: cctpBridge }]]),
        );

        return [
          currentChain,
          {
            type: TokenType.collateral,
            token: usdcTokenAddress,
            mailbox: routerConfig[currentChain].mailbox,
            owner,
            allowedRebalancers: [REBALANCER],
            allowedRebalancingBridges: allowedRebalancingBridges,
            contractVersion: existingChains.includes(currentChain)
              ? CONTRACTS_PACKAGE_VERSION
              : undefined,
          },
        ];
      },
    ),
  );
};
