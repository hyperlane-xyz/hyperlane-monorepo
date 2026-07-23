import chalk from 'chalk';

import { ISafe__factory } from '@hyperlane-xyz/core';
import {
  type AccountConfig,
  type AcceptedInactiveOwner,
  type ChainName,
  InterchainAccount,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import { type Address, eqAddress } from '@hyperlane-xyz/utils';

// A nonce-less / lazily-deployed governance ICA (Tron and other AltVM) has no
// contract code and no nonce, so the ownerStatus virtual check derives it as
// Inactive and forces expected=Active — a permanent, unresolvable false
// positive even though the owner is a perfectly good multisig-controlled ICA.
//
// The SDK checker no longer knows anything about ICAs: it only passes an
// Inactive owner through as acceptable when infra hands it an explicit
// { chain, owner } verdict (see checkWarpRouteDeployConfig's
// `acceptedInactiveOwners`). This file owns the governance decision: it
// DECLARES the intended ICA per route and DERIVES + VERIFIES it at runtime.
//
// A declaration is the source of intent — we never reconstruct the AccountConfig
// by assuming Ethereum or inferring it from the route. For each declaration we:
//   1. derive the leaf-chain ICA from the declared origin owner via
//      InterchainAccount.getAccount,
//   2. require the derived ICA to equal the declared ICA,
//   3. require the declared origin owner to be a Safe with threshold > 1.
// Only then do we emit { chain: destination, owner: derivedIca } as accepted.
// The SDK matches that owner against the observed on-chain owner, which supplies
// the final derivedIca == onChainOwner check, so we don't re-read the route.
//
// Everything uncertain FAILS CLOSED (owner not accepted → violation still
// fires): a missing declaration, a derivation mismatch or error, a Safe RPC
// failure, or a threshold <= 1. This preserves the anti-1-of-1 signal the
// ownerStatus check exists for.
export interface GovernanceIcaOwnerDeclaration {
  warpRouteId: string;
  // Leaf chain whose on-chain owner is the (Inactive) governance ICA.
  destination: ChainName;
  // The ICA we expect to derive; cross-checked against the derivation so a
  // stale/incorrect declaration fails closed rather than silently accepting a
  // different owner.
  declaredIca: Address;
  // Explicit origin chain + owner (and optional ICA routing overrides). This is
  // the source of intent — NOT inferred from the route.
  accountConfig: AccountConfig;
}

export const GOVERNANCE_ICA_OWNERS: GovernanceIcaOwnerDeclaration[] = [
  {
    warpRouteId: 'USDT/eclipsemainnet',
    destination: 'tron',
    declaredIca: '0xB960616C7E2ee0F2a296A4b2B9D0b3308E23A69D',
    accountConfig: {
      origin: 'ethereum',
      owner: '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6',
    },
  },
];

// Derives + verifies a single governance ICA declaration. Returns the accepted
// verdict, or undefined if anything is uncertain (fail-closed): a derivation
// mismatch or error, a Safe RPC failure, or a threshold <= 1.
export async function verifyGovernanceIcaOwner({
  declaration,
  interchainAccount,
  multiProvider,
}: {
  declaration: GovernanceIcaOwnerDeclaration;
  interchainAccount: InterchainAccount;
  multiProvider: MultiProvider;
}): Promise<AcceptedInactiveOwner | undefined> {
  const { warpRouteId, destination, declaredIca, accountConfig } = declaration;
  const label = `${warpRouteId} ${destination} ICA ${declaredIca}`;

  // 1. Derive the leaf-chain ICA from the declared origin owner.
  let derivedIca: Address;
  try {
    derivedIca = await interchainAccount.getAccount(destination, accountConfig);
  } catch (e) {
    console.warn(
      chalk.yellow(`Skipping ${label}: ICA derivation failed: ${e}`),
    );
    return undefined;
  }

  // 2. Require the derivation to match the declared ICA.
  if (!eqAddress(derivedIca, declaredIca)) {
    console.warn(
      chalk.yellow(
        `Skipping ${label}: derived ICA ${derivedIca} != declared ${declaredIca}`,
      ),
    );
    return undefined;
  }

  // 3. Anti-1-of-1: require the origin owner to be a Safe with threshold > 1.
  // A non-Safe origin owner (getThreshold reverts) or a 1-of-1 Safe fails.
  try {
    const safe = ISafe__factory.connect(
      accountConfig.owner,
      multiProvider.getProvider(accountConfig.origin),
    );
    const threshold = await safe.getThreshold();
    if (!threshold.gt(1)) {
      console.warn(
        chalk.yellow(
          `Skipping ${label}: origin Safe threshold ${threshold.toString()} <= 1`,
        ),
      );
      return undefined;
    }
  } catch (e) {
    console.warn(
      chalk.yellow(`Skipping ${label}: origin Safe check failed: ${e}`),
    );
    return undefined;
  }

  return { chain: destination, owner: derivedIca };
}

// Resolves the accepted Inactive owners for a route by deriving + verifying its
// governance ICA declarations. Fail-closed: any uncertainty drops the owner
// from the result so the ownerStatus violation still fires. A missing
// declaration simply yields no accepted owners.
//
// When `destinations` is provided (e.g. a --chains-filtered check), only
// declarations whose destination is in that set are resolved, so an excluded
// leaf chain's ICA derivation and Safe RPC are never attempted.
export async function resolveAcceptedInactiveOwners({
  warpRouteId,
  interchainAccount,
  multiProvider,
  destinations,
}: {
  warpRouteId: string;
  interchainAccount: InterchainAccount;
  multiProvider: MultiProvider;
  destinations?: readonly ChainName[];
}): Promise<AcceptedInactiveOwner[]> {
  const allowedDestinations = destinations && new Set(destinations);
  const declarations = GOVERNANCE_ICA_OWNERS.filter(
    (declaration) =>
      declaration.warpRouteId === warpRouteId &&
      (!allowedDestinations ||
        allowedDestinations.has(declaration.destination)),
  );

  const verdicts = await Promise.all(
    declarations.map((declaration) =>
      verifyGovernanceIcaOwner({
        declaration,
        interchainAccount,
        multiProvider,
      }),
    ),
  );

  return verdicts.filter(
    (verdict): verdict is AcceptedInactiveOwner => verdict !== undefined,
  );
}
