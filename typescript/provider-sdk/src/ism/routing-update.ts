import { isNullish } from '@hyperlane-xyz/utils';

import { IsmType } from '../altvm.js';
import {
  ArtifactDeployed,
  ArtifactState,
  ArtifactUnderived,
} from '../artifact.js';
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
 * Protocol-agnostic comparison logic without transaction building.
 * VM SDKs use this to determine what routes to add/remove.
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

/**
 * Pure function that transforms a routing ISM query result from chain
 * into a deployed artifact structure.
 *
 * Converts the routes array from the query into a domains object where
 * each nested ISM is marked as UNDERIVED (address-only reference).
 *
 * @param queryResult - Raw routing ISM data from chain query
 * @returns Deployed routing ISM artifact with UNDERIVED nested ISMs
 */
export function routingIsmQueryResultToArtifact(queryResult: {
  address: string;
  owner: string;
  routes: Array<{ domainId: number; ismAddress: string }>;
}): ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress> {
  const domains: Record<number, ArtifactUnderived<DeployedIsmAddress>> = {};

  for (const route of queryResult.routes) {
    domains[route.domainId] = {
      deployed: {
        address: route.ismAddress,
      },
      artifactState: ArtifactState.UNDERIVED,
    };
  }

  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: IsmType.ROUTING,
      owner: queryResult.owner,
      domains,
    },
    deployed: {
      address: queryResult.address,
    },
  };
}
