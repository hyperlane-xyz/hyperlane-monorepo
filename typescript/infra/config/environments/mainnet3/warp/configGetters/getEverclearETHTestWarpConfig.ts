import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

export const ETH_EVERCLEAR_CHAINS = ['optimism', 'arbitrum', 'base'] as const;

type EthEverclearChain = (typeof ETH_EVERCLEAR_CHAINS)[number];

const wethAddressesByChain: Record<EthEverclearChain, Address> = {
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  base: '0x4200000000000000000000000000000000000006',
  optimism: '0x4200000000000000000000000000000000000006',
};

const everclearFeeAdapterByChain: Record<EthEverclearChain, Address> = {
  arbitrum: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  base: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
  optimism: '0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75',
};

const everclearDomainIdByChain: Record<EthEverclearChain, number> = {
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
};

export const getETHEverclearTestWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    ETH_EVERCLEAR_CHAINS.map((chain) => {
      const owner = DEPLOYER;

      const wethAddress = wethAddressesByChain[chain];
      assert(wethAddress, `WETH address not found for ${chain}`);

      const everclearBridgeAddress = everclearFeeAdapterByChain[chain];
      assert(
        everclearBridgeAddress,
        `Everclear fee adapter address not found for ${chain}`,
      );

      const outputAssets = Object.fromEntries(
        ETH_EVERCLEAR_CHAINS.filter(
          (currentChain) => currentChain !== chain,
        ).map((currentChain) => [
          everclearDomainIdByChain[currentChain],
          wethAddressesByChain[currentChain],
        ]),
      );

      const config: HypTokenRouterConfig = {
        owner,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.ethEverclear,
        wethAddress,
        everclearBridgeAddress,
        // Dummy values for now
        everclearFeeParams: {
          deadline: Date.now() + 24 * 60 * 60,
          fee: 0,
          signature: '0x42',
        },
        outputAssets,
      };

      return [chain, config];
    }),
  );
};
