import { compareVersions } from 'compare-versions';
import { z } from 'zod';

import { CONTRACTS_PACKAGE_VERSION } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

export const contractVersionMatchesDependency = (version: string) => {
  return compareVersions(version, CONTRACTS_PACKAGE_VERSION) === 0;
};

export const VersionedSchema = z.object({
  contractVersion: z.string().optional(),
});

type VersionedConfig = z.infer<typeof VersionedSchema>;

export function shouldUpgrade(
  current: VersionedConfig,
  target: VersionedConfig,
): boolean {
  assert(current.contractVersion, 'Actual contract version is undefined');

  // Only upgrade if the user specifies a version
  if (!target.contractVersion) {
    return false;
  }

  const comparisonValue = compareVersions(
    target.contractVersion,
    current.contractVersion,
  );

  // Expected version is lower than actual version, no upgrade is possible
  if (comparisonValue === -1) {
    throw new Error(
      `Expected contract version ${target.contractVersion} is lower than actual contract version ${current.contractVersion}`,
    );
  }
  // Versions are the same, no upgrade needed
  if (comparisonValue === 0) {
    return false;
  }

  // You can only upgrade to the @hyperlane-xyz/core dependency version (see `PackageVersioned`)
  assert(
    contractVersionMatchesDependency(target.contractVersion),
    `Contract version must match the @hyperlane-xyz/core dependency version (${CONTRACTS_PACKAGE_VERSION})`,
  );

  return true;
}
