import { isNullish } from '@hyperlane-xyz/utils';

import { ArtifactDeployed } from '../artifact.js';
import { DeployedIsmAddress, RawRoutingIsmArtifactConfig } from '../ism.js';

/**
 * Domain route changes for a routing ISM.
 * Used to describe what domain routes need to be added/removed.
 */
export interface RoutingIsmDomainChanges {
  setRoutes: Array<{ domain: number; ismAddress: string }>;
  removeRoutes: Array<{ domain: number }>;
}

/**
 * Pure function that computes domain route changes needed to update
 * a routing ISM from current state to expected state.
 *
 * Extracts the core algorithm from AltvmRoutingIsmWriter.update() without
 * protocol-specific dependencies or transaction building.
 *
 * @param current - Current deployed routing ISM artifact with config
 * @param expected - Expected routing ISM configuration
 * @param eqAddress - Protocol-specific address equality function
 * @returns Domain route changes (add/remove) needed
 */
export function computeRoutingIsmDomainChanges(
  current: ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
  expected: RawRoutingIsmArtifactConfig,
  eqAddress: (a: string, b: string) => boolean,
): RoutingIsmDomainChanges {
  const setRoutes: Array<{ domain: number; ismAddress: string }> = [];
  const removeRoutes: Array<{ domain: number }> = [];

  // Add or update domain routes
  for (const [domainId, expectedIsm] of Object.entries(expected.domains)) {
    const domain = parseInt(domainId);
    const currentIsmAddress = current.config.domains[domain]
      ? current.config.domains[domain].deployed.address
      : undefined;
    // expectedIsm is ArtifactOnChain which always has .deployed
    const expectedIsmAddress = expectedIsm.deployed.address;

    if (
      isNullish(currentIsmAddress) ||
      !eqAddress(currentIsmAddress, expectedIsmAddress)
    ) {
      setRoutes.push({ domain, ismAddress: expectedIsmAddress });
    }
  }

  // Remove domain routes
  for (const domainId of Object.keys(current.config.domains)) {
    const domain = parseInt(domainId);
    if (isNullish(expected.domains[domain])) {
      removeRoutes.push({ domain });
    }
  }

  return { setRoutes, removeRoutes };
}
