import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { stubPackageVersion } from '../test/contractStubs.js';
import {
  lsp17NoExtensionError,
  missingSelectorError,
  networkError,
  panicRevertError,
  wrappedError,
} from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import {
  LEGACY_PACKAGE_VERSION,
  fetchPackageVersion,
  isMissingSelectorCallException,
  isMissingSelectorRevert,
  isRevertWithData,
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

  describe('isRevertWithData', () => {
    interface Case {
      name: string;
      error: () => unknown;
      expected: boolean;
    }

    const cases: Case[] = [
      { name: 'panic revert', error: panicRevertError, expected: true },
      {
        name: 'LSP17 no-extension revert',
        error: lsp17NoExtensionError,
        expected: true,
      },
      {
        name: 'wrapped panic revert',
        error: () => wrappedError(panicRevertError()),
        expected: true,
      },
      {
        name: 'revert data on nested error.data',
        error: () =>
          Object.assign(new Error('call revert exception'), {
            code: 'CALL_EXCEPTION',
            error: { data: '0x08c379a0abcd' },
          }),
        expected: true,
      },
      {
        name: 'empty data (missing selector)',
        error: missingSelectorError,
        expected: false,
      },
      {
        name: 'empty provider response',
        error: () => new Error('Invalid response from provider'),
        expected: false,
      },
      { name: 'network error', error: networkError, expected: false },
      {
        name: 'data shorter than a selector',
        error: () =>
          Object.assign(new Error('call revert exception'), {
            code: 'CALL_EXCEPTION',
            data: '0x4e487b',
          }),
        expected: false,
      },
      {
        name: 'non-hex data',
        error: () =>
          Object.assign(new Error('call revert exception'), {
            code: 'CALL_EXCEPTION',
            data: '0xzzzzzzzzzz',
          }),
        expected: false,
      },
      {
        name: 'call exception without data',
        error: () =>
          Object.assign(new Error('call revert exception'), {
            code: 'CALL_EXCEPTION',
          }),
        expected: false,
      },
    ];

    for (const c of cases) {
      it(`returns ${c.expected} for ${c.name}`, () => {
        expect(isRevertWithData(c.error())).to.equal(c.expected);
      });
    }

    it('is not a missing selector for data-carrying reverts', () => {
      expect(isMissingSelectorRevert(panicRevertError())).to.equal(false);
      expect(isMissingSelectorCallException(panicRevertError())).to.equal(
        false,
      );
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
      stubPackageVersion(sandbox, sandbox.stub().resolves('5.4.0'));

      const version = await fetchPackageVersion(provider, randomAddress());

      expect(version).to.equal('5.4.0');
    });

    it('falls back to LEGACY_PACKAGE_VERSION on a missing selector', async () => {
      stubPackageVersion(
        sandbox,
        sandbox.stub().rejects(missingSelectorError()),
      );

      const version = await fetchPackageVersion(provider, randomAddress());

      expect(version).to.equal(LEGACY_PACKAGE_VERSION);
    });

    it('rethrows a transient provider error', async () => {
      const transientError = networkError();
      stubPackageVersion(sandbox, sandbox.stub().rejects(transientError));

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
