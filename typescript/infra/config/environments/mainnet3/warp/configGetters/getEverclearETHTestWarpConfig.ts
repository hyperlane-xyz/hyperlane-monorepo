import {
  ChainMap,
  EverclearCollateralTokenConfig,
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

const feeParamsByChain: Record<
  EthEverclearChain,
  EverclearCollateralTokenConfig['everclearFeeParams']
> = {
  // Only valid for ARB -> OP
  arbitrum: {
    fee: 250000000000000,
    deadline: 1758184098,
    signature:
      '0x0d126b17f86ee8b7b8609a6d2222053637e37fb4aab135e8f133d590c355c1a9371d7ff0214c58240d805323387d86ecdc0d3eca805f06a4c077b129765b6f3a1c',
  },
  // Dummy values for now
  base: {
    deadline: Date.now() + 24 * 60 * 60,
    fee: 0,
    signature: '0x42',
  },
  // Only valid for OP -> ARB
  optimism: {
    fee: 250000000000000,
    deadline: 1758184172,
    signature:
      '0x1515ff1f5a8a168e93a08bf1e3a2aae4599894dbbfbe185a20a2c3fff33091bb6300bbd54bd4c2455717129a683f4314f47a3f5fae3d5648afd7ed040877e2c21c',
  },
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

      const feeParams = feeParamsByChain[chain];
      assert(feeParams, `Everclear feeParams not found for ${chain}`);

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
        everclearFeeParams: feeParams,
        outputAssets,
      };

      return [chain, config];
    }),
  );
};
