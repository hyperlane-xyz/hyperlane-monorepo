import assert from 'assert';

import { ChainMap, ChainName, MovableTokenConfig } from '@hyperlane-xyz/sdk';
import { arrayToObject, objMap } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

type RebalancingConfig = Required<
  Pick<MovableTokenConfig, 'allowedRebalancingBridges' | 'allowedRebalancers'>
>;

export function getUSDCRebalancingBridgesConfigFor(
  deploymentChains: readonly ChainName[],
): ChainMap<RebalancingConfig> {
  const registry = getRegistry();
  const mainnetCCTP = registry.getWarpRoute(WarpRouteIds.MainnetCCTP);

  assert(mainnetCCTP, 'MainnetCCTP warp route not found');

  const cctpBridgeChains = new Set(
    mainnetCCTP.tokens.map(({ chainName }) => chainName),
  );

  const rebalanceableChains = deploymentChains.filter((chain) =>
    cctpBridgeChains.has(chain),
  );

  const cctpBridgesByChain = Object.fromEntries(
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

  return objMap(
    arrayToObject(rebalanceableChains),
    (currentChain): RebalancingConfig => {
      const cctpBridge = cctpBridgesByChain[currentChain];
      assert(cctpBridge, `No cctp bridge found for chain ${currentChain}`);

      const allowedRebalancingBridges = Object.fromEntries(
        rebalanceableChains
          .filter((remoteChain) => remoteChain !== currentChain)
          .map((remoteChain) => [remoteChain, [{ bridge: cctpBridge }]]),
      );

      return {
        allowedRebalancers: [REBALANCER],
        allowedRebalancingBridges,
      };
    },
  );
}
