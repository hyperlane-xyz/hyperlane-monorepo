import { PackageVersioned__factory } from '@hyperlane-xyz/core';
import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { missingSelectorError, networkError } from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';

describe('EvmWarpRouteReader', () => {
  let sandbox: sinon.SinonSandbox;
  let reader: EvmWarpRouteReader;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    reader = new EvmWarpRouteReader(
      MultiProvider.createTestMultiProvider(),
      TestChainName.test1,
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('falls back to the legacy package version when PACKAGE_VERSION is missing', async () => {
    sandbox.stub(PackageVersioned__factory, 'connect').returns({
      PACKAGE_VERSION: sandbox.stub().rejects(missingSelectorError()),
    } as any);

    const version = await reader.fetchPackageVersion(randomAddress());

    expect(version).to.equal('5.3.9');
  });

  it('throws transient package version probe failures', async () => {
    const transientError = networkError();
    sandbox.stub(PackageVersioned__factory, 'connect').returns({
      PACKAGE_VERSION: sandbox.stub().rejects(transientError),
    } as any);

    let thrown: unknown;
    try {
      await reader.fetchPackageVersion(randomAddress());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });
});
