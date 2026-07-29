import { PackageVersioned__factory } from '@hyperlane-xyz/core';
import sinon from 'sinon';

/**
 * Stubs `PackageVersioned__factory.connect` so callers exercise only the
 * `PACKAGE_VERSION()` read that `fetchPackageVersion` performs.
 * Note: callers should call `sandbox.restore()` after tests complete.
 */
export function stubPackageVersion(
  sandbox: sinon.SinonSandbox,
  packageVersion: () => Promise<string>,
): void {
  // CAST: connect() returns the fully generated PackageVersioned contract type;
  // the code under test only invokes PACKAGE_VERSION(), so stubbing the entire
  // contract is impractical and we narrow to the single method being read.
  sandbox.stub(PackageVersioned__factory, 'connect').returns({
    PACKAGE_VERSION: packageVersion,
  } as ReturnType<typeof PackageVersioned__factory.connect>);
}
