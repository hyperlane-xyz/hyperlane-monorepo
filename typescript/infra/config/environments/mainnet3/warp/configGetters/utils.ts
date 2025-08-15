import assert from 'assert';

import { ChainMap, ChainName, MovableTokenConfig } from '@hyperlane-xyz/sdk';
import { arrayToObject, objMap } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

type RebalancingConfig = Required<
  Pick<MovableTokenConfig, 'allowedRebalancingBridges' | 'allowedRebalancers'>
>;

export function getETHRebalancingBridgesConfigFor(
  deploymentChains: readonly ChainName[],
): ChainMap<RebalancingConfig> {
  const registry = getRegistry();
  const ethEverclear = registry.getWarpRoute(WarpRouteIds.ETHEverclearTest);

  assert(ethEverclear, 'Eth everclear warp route not found');

  const ethEverclearBridgeChains = new Set(
    ethEverclear.tokens.map(({ chainName }) => chainName),
  );

  const rebalanceableChains = deploymentChains.filter((chain) =>
    ethEverclearBridgeChains.has(chain),
  );

  const ethEverclearBridgesByChain = Object.fromEntries(
    ethEverclear.tokens.map(
      ({ chainName, addressOrDenom }): [string, string] => {
        assert(
          addressOrDenom,
          `Expected eth everclear bridge address to be defined on chain ${chainName}`,
        );

        return [chainName, addressOrDenom];
      },
    ),
  );

  return objMap(
    arrayToObject(rebalanceableChains),
    (currentChain): RebalancingConfig => {
      const ethEverclear = ethEverclearBridgesByChain[currentChain];
      assert(
        ethEverclear,
        `No eth everclear bridge found for chain ${currentChain}`,
      );

      const allowedRebalancingBridges = Object.fromEntries(
        rebalanceableChains
          .filter((remoteChain) => remoteChain !== currentChain)
          .map((remoteChain) => [remoteChain, [{ bridge: ethEverclear }]]),
      );

      return {
        allowedRebalancers: [REBALANCER],
        allowedRebalancingBridges,
      };
    },
  );
}
