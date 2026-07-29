import { WARP_ROUTE_CHECK_TYPE } from '@hyperlane-xyz/sdk';

// Legacy warp routes whose owner on a given chain is intentionally an inactive
// EOA (nonce 0, no code) rather than a live account or Safe. The ownerStatus
// virtual check maps any Inactive owner to expected=Active (see
// expandWarpDeployConfig in configUtils.ts), so these routes emit a permanent
// ConfigMismatch that cannot be resolved without a live ownership migration.
// Allowlist the specific {route, chain, owner} so ONLY that ownerStatus
// violation is suppressed — every other check on the route still runs.
export interface OwnerStatusSkip {
  warpRouteId: string;
  chain: string;
  // Required: only the ownerStatus violation for this exact owner is skipped.
  // We never suppress ownerStatus chain-wide — a future owner change on the
  // same route+chain must still surface as a violation.
  owner: string;
}

export const OWNER_STATUS_SKIP: OwnerStatusSkip[] = [
  {
    warpRouteId: 'BEST/ethereum',
    chain: 'bsc',
    owner: '0x081Ec7bf32dEf8730DABc19dBA69a6E86dC0Ae2E',
  },
  {
    warpRouteId: 'BEST/ethereum',
    chain: 'ethereum',
    owner: '0x081Ec7bf32dEf8730DABc19dBA69a6E86dC0Ae2E',
  },
  {
    warpRouteId: 'GNET/galactica',
    chain: 'galactica',
    owner: '0xFe758b0Bc6aA63Ff0Db876F3ed38204a2e413060',
  },
  {
    warpRouteId: 'USDC/coti-ethereum',
    chain: 'coti',
    owner: '0xdF2E2886d23ba57F996C203D2Ccd9dCa6373590C',
  },
  {
    warpRouteId: 'WBTC/coti-ethereum',
    chain: 'coti',
    owner: '0xdF2E2886d23ba57F996C203D2Ccd9dCa6373590C',
  },
];

// ownerStatus virtual-config violations carry a field path of the form
// `ownerStatus.<ownerAddress>`, so match on that prefix plus the allowlisted
// route/chain/owner.
export function isSkippedOwnerStatusViolation(
  warpRouteId: string,
  violation: { chain: string; name: string },
): boolean {
  if (!violation.name.toLowerCase().includes('ownerstatus')) {
    return false;
  }
  const violationName = violation.name.toLowerCase();
  return OWNER_STATUS_SKIP.some(
    (skip) =>
      skip.warpRouteId === warpRouteId &&
      skip.chain === violation.chain &&
      violationName.includes(skip.owner.toLowerCase()),
  );
}

export interface OwnerStatusClearTarget {
  warpRouteId: string;
  chain: string;
  contractName: string;
  violationType: string;
}

// The firing PushGateway series for a skipped ownerStatus violation is keyed by
// (warp_route_id, chain, contract_name=`ownerStatus.<owner>`, type=ConfigMismatch).
// Merging the skip alone stops the checker from refreshing these series but does
// not delete the ones already at 1, so we derive the exact clear targets from the
// same allowlist for a one-time rollout clear (see clear-skipped-owner-status.ts).
export function ownerStatusClearTargets(): OwnerStatusClearTarget[] {
  return OWNER_STATUS_SKIP.map((skip) => ({
    warpRouteId: skip.warpRouteId,
    chain: skip.chain,
    contractName: `ownerStatus.${skip.owner}`,
    violationType: WARP_ROUTE_CHECK_TYPE,
  }));
}
