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
  arbitrum: {
    fee: 1000000000000,
    deadline: 1753302081,
    signature:
      '0x706f864759e9315d1cc5303a8eb1b02e4e494b4bad9bf8602d5749fa5740ca9134fb2a071f891a35bb949e269f29d4972d2e424dfc2c439275ef8c5af67d82ca1b',
  },
  // Dummy values for now
  base: {
    deadline: Date.now() + 24 * 60 * 60,
    fee: 0,
    signature: '0x42',
  },
  optimism: {
    fee: 1000000000000,
    deadline: 1753306369,
    signature:
      '0x3f9a555cc805205c882e5ffba911b5c8427b4537b64b271d6af15ebf0e4e8eac6b0642f6ccc465649f41e85ce92b9bd26d0b20c4582be5807b9eb4e162d828e71b',
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
