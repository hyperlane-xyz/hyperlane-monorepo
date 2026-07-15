import { PackageVersioned__factory } from '@hyperlane-xyz/core';
import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  missingSelectorError,
  networkError,
  wrappedError,
} from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import {
  LEGACY_PACKAGE_VERSION,
  fetchPackageVersion,
  isMissingSelectorCallException,
  isMissingSelectorRevert,
} from './contract.js';

describe('contract utils', () => {
  describe('isMissingSelectorCallException', () => {
    it('matches empty call exceptions', () => {
      expect(isMissingSelectorCallException(missingSelectorError())).to.equal(
        true,
      );
    });

    it('matches SmartProvider-wrapped empty call exceptions', () => {
      expect(
        isMissingSelectorCallException(wrappedError(missingSelectorError())),
      ).to.equal(true);
    });

    it('matches deeply wrapped empty call exceptions', () => {
      expect(
        isMissingSelectorCallException(
          wrappedError(wrappedError(missingSelectorError())),
        ),
      ).to.equal(true);
    });

    it('matches HyperlaneJsonRpcProvider empty responses', () => {
      expect(
        isMissingSelectorCallException(
          new Error('Invalid response from provider'),
        ),
      ).to.equal(true);
      expect(
        isMissingSelectorRevert(new Error('Invalid response from provider')),
      ).to.equal(false);
    });

    it('matches SmartProvider-wrapped empty provider responses', () => {
      expect(
        isMissingSelectorCallException(
          wrappedError(new Error('Invalid response from provider')),
        ),
      ).to.equal(true);
    });

    it('does not match non-call exceptions with formatted empty data', () => {
      expect(
        isMissingSelectorCallException(
          new Error('request failed with data="0x"'),
        ),
      ).to.equal(false);
    });
  });

  describe('fetchPackageVersion', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    const provider = MultiProvider.createTestMultiProvider().getProvider(
      TestChainName.test1,
    );

    it('returns the on-chain version', async () => {
      sandbox.stub(PackageVersioned__factory, 'connect').returns({
        PACKAGE_VERSION: sandbox.stub().resolves('5.4.0'),
      } as any);

      const version = await fetchPackageVersion(provider, randomAddress());

      expect(version).to.equal('5.4.0');
    });

    it('falls back to LEGACY_PACKAGE_VERSION on a missing selector', async () => {
      sandbox.stub(PackageVersioned__factory, 'connect').returns({
        PACKAGE_VERSION: sandbox.stub().rejects(missingSelectorError()),
      } as any);

      const version = await fetchPackageVersion(provider, randomAddress());

      expect(version).to.equal(LEGACY_PACKAGE_VERSION);
    });

    it('rethrows a transient provider error', async () => {
      const transientError = networkError();
      sandbox.stub(PackageVersioned__factory, 'connect').returns({
        PACKAGE_VERSION: sandbox.stub().rejects(transientError),
      } as any);

      let thrown: unknown;
      try {
        await fetchPackageVersion(provider, randomAddress());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.equal(transientError);
    });
  });
});
