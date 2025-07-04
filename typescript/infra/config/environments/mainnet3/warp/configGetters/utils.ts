import assert from 'assert';

import { ChainName, MovableTokenConfig } from '@hyperlane-xyz/sdk';

import { getRegistry } from '../../../../registry.js';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

export function getRebalancingBridgesConfigFor(
  currentChain: ChainName,
  deploymentChains: readonly ChainName[],
  chainsToExclude: readonly ChainName[] = [],
): Required<
  Pick<MovableTokenConfig, 'allowedRebalancingBridges' | 'allowedRebalancers'>
> {
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

  const cctpBridge = cctpBridges[currentChain];
  assert(cctpBridge, `No cctp bridge found for chain ${currentChain}`);

  const allowedRebalancingBridges = Object.fromEntries(
    deploymentChains
      .filter(
        (remoteChain) =>
          remoteChain !== currentChain &&
          !chainsToExclude.includes(remoteChain),
      )
      .map((remoteChain) => [remoteChain, [{ bridge: cctpBridge }]]),
  );

  return {
    allowedRebalancers: [REBALANCER],
    allowedRebalancingBridges,
  };
}
