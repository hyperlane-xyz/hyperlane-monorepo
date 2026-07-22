import { ISafe__factory } from '@hyperlane-xyz/core';
import {
  InterchainAccount,
  OwnerStatus,
  WarpRouteCheckViolation,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { eqAddress, rootLogger } from '@hyperlane-xyz/utils';

// The ownerStatus check is not just an owner-match check: it exists to catch
// single-point-of-failure (1-of-1) ownership. On nonce-less / lazily-deployed
// chains (Tron and other AltVM) a governance ICA owner has no contract code and
// no nonce, so `isAddressActive` derives it as Inactive and the virtual check
// forces expected=Active — an unresolvable false positive even though the owner
// is a perfectly good multisig-controlled ICA.
//
// Rather than allowlisting each such owner (which silences the anti-1-of-1
// signal), we resolve it: assume Ethereum is the ICA origin, take the route's
// Ethereum-leg owner as the single candidate origin owner, derive the leaf ICA
// from it, and only clear the violation if that derivation matches the on-chain
// leaf owner AND the origin owner is a Safe with threshold > 1. A 1-of-1 origin
// Safe (or a non-Safe origin owner) still surfaces.
const ICA_ORIGIN_CHAIN = 'ethereum';

const logger = rootLogger.child({ module: 'resolve-ica-owner-status' });

// ownerStatus virtual-config violations carry a field path of the form
// `ownerStatus.<ownerAddress>`. Return the owner address, or undefined if this
// is not an Inactive ownerStatus violation.
function inactiveOwnerFromViolation(
  violation: WarpRouteCheckViolation,
): string | undefined {
  const [prefix, owner] = violation.name.split('.');
  if (prefix?.toLowerCase() !== 'ownerstatus' || !owner) {
    return undefined;
  }
  if (violation.actual.toLowerCase() !== OwnerStatus.Inactive) {
    return undefined;
  }
  return owner;
}

/**
 * Resolves whether an Inactive `ownerStatus` violation is a false positive
 * caused by a governance ICA owner on a nonce-less/lazily-deployed leaf chain.
 *
 * Only runs on the failing (Inactive) path, leaving every other violation and
 * chain untouched. Returns true only when the leaf owner is provably a
 * governance ICA derived from a >1-of-n Ethereum Safe.
 */
export async function isClearedIcaOwnerStatusViolation(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  interchainAccountApp: InterchainAccount,
  violation: WarpRouteCheckViolation,
): Promise<boolean> {
  const owner = inactiveOwnerFromViolation(violation);
  if (!owner) {
    return false;
  }

  const chain = violation.chain;
  // The heuristic resolves leaf-chain ICAs against the Ethereum origin; the
  // origin chain itself is not a leaf and is checked normally.
  if (chain === ICA_ORIGIN_CHAIN) {
    return false;
  }

  // Assume Ethereum as the ICA origin and take the Ethereum-leg owner as the
  // single candidate origin owner. Routes without an Ethereum leg can't use
  // this heuristic.
  const originOwner = warpDeployConfig[ICA_ORIGIN_CHAIN]?.owner;
  if (!originOwner) {
    return false;
  }

  const multiProvider = interchainAccountApp.multiProvider;

  // Derive the leaf-chain ICA from the origin owner. If it matches the leaf's
  // on-chain owner, that owner is the governance ICA of the origin owner.
  let derivedIca: string;
  try {
    derivedIca = await interchainAccountApp.getAccount(chain, {
      origin: ICA_ORIGIN_CHAIN,
      owner: originOwner,
    });
  } catch (error) {
    logger.debug(
      { chain, originOwner, error },
      'Could not derive ICA for owner-status resolution; leaving violation',
    );
    return false;
  }

  if (!eqAddress(derivedIca, owner)) {
    return false;
  }

  // Anti-1-of-1: only clear if the origin owner is a Safe with threshold > 1.
  // A non-Safe origin owner (getThreshold reverts) or a 1-of-1 Safe still fires.
  try {
    const safe = ISafe__factory.connect(
      originOwner,
      multiProvider.getProvider(ICA_ORIGIN_CHAIN),
    );
    const threshold = await safe.getThreshold();
    if (threshold.gt(1)) {
      logger.info(
        {
          chain,
          owner,
          originOwner,
          threshold: threshold.toString(),
        },
        'Cleared Inactive ownerStatus: leaf owner is a governance ICA of a >1-of-n Safe',
      );
      return true;
    }
    logger.warn(
      { chain, owner, originOwner, threshold: threshold.toString() },
      'ICA origin owner is a 1-of-1 Safe; keeping ownerStatus violation',
    );
    return false;
  } catch (error) {
    logger.debug(
      { chain, owner, originOwner, error },
      'ICA origin owner is not a Safe; keeping ownerStatus violation',
    );
    return false;
  }
}
