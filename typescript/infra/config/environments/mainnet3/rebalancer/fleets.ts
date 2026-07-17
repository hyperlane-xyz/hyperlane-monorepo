import { assert } from '@hyperlane-xyz/utils';

export interface RebalancerFleetDefinition {
  name: string;
  warpRouteIds: string[];
}

export const rebalancerFleets: RebalancerFleetDefinition[] = [
  {
    name: 'usdc-sol-fleet',
    warpRouteIds: [
      'USDC/eclipsemainnet',
      'USDC/radix',
      'USDC/subtensor',
      'USDC/aleo',
      'USDC/paradex',
      'USDC/superseed',
    ],
  },
];

export function getRebalancerFleet(
  name: string,
): RebalancerFleetDefinition {
  const fleet = rebalancerFleets.find((candidate) => candidate.name === name);
  assert(fleet, `Rebalancer fleet not found: ${name}`);
  return fleet;
}
