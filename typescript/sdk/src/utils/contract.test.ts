import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { stubPackageVersion } from '../test/contractStubs.js';
import {
  errorStringRevertError,
  ethersCallExceptionWithNestedError,
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
  isPanicRevert,
  isReturnDataEmpty,
} from './contract.js';

function facetNotFoundError(): Error & { code: string; data: string } {
  return Object.assign(new Error('call reverted with FacetNotFound()'), {
    code: 'CALL_EXCEPTION',
    data: '0x800ab12c',
  });
}

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

    it('matches direct and wrapped diamond FacetNotFound reverts', () => {
      expect(isMissingSelectorCallException(facetNotFoundError())).to.equal(
        true,
      );
      expect(
        isMissingSelectorCallException(wrappedError(facetNotFoundError())),
      ).to.equal(true);
    });

    it('matches FacetNotFound revert data nested in the underlying error but not with trailing bytes', () => {
      expect(
        isMissingSelectorCallException(
          Object.assign(new Error('call revert exception'), {
            code: 'CALL_EXCEPTION',
            error: { data: '0x800ab12c' },
          }),
        ),
      ).to.equal(true);
      expect(
        isMissingSelectorCallException(
          Object.assign(new Error('call revert exception'), {
            code: 'CALL_EXCEPTION',
            data: `0x800ab12c${'00'.repeat(32)}`,
          }),
        ),
      ).to.equal(false);
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

  describe('isMissingSelectorCallException with nested ethers errors', () => {
    interface Case {
      name: string;
      nested: object;
      expected: boolean;
    }

    const cases: Case[] = [
      {
        name: 'JSON-RPC code 3 revert without data',
        nested: Object.assign(new Error('execution reverted'), {
          code: 3,
          data: '0x',
        }),
        expected: true,
      },
      {
        name: 'JSON-RPC -32000 execution reverted',
        nested: Object.assign(new Error('execution reverted'), {
          code: -32000,
        }),
        expected: true,
      },
      {
        name: 'hardhat VM exception revert',
        nested: Object.assign(
          new Error(
            "VM Exception while processing transaction: reverted with reason string ''",
          ),
          { code: -32603 },
        ),
        expected: true,
      },
      {
        name: 'revert JSON body inside an HTTP error response (transient, like SmartProvider)',
        nested: {
          code: 'SERVER_ERROR',
          message: 'processing response error',
          body: '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"x"}}',
        },
        expected: false,
      },
      {
        name: 'HTTP 500 server error',
        nested: {
          code: 'SERVER_ERROR',
          message:
            'processing response error (body="Internal Server Error", responseText="Internal Server Error", requestBody="{}", requestMethod="POST", url="http://x", code=SERVER_ERROR, version=web/5.8.0)',
          body: 'Internal Server Error',
          status: 500,
        },
        expected: false,
      },
      {
        name: 'JSON-RPC -32000 header not found',
        nested: Object.assign(new Error('header not found'), { code: -32000 }),
        expected: false,
      },
      {
        name: 'connection reset (missing response)',
        nested: {
          code: 'SERVER_ERROR',
          message:
            'missing response (requestBody="{}", requestMethod="POST", serverError={"code":"ECONNRESET"}, url="http://x", code=SERVER_ERROR, version=web/5.8.0)',
        },
        expected: false,
      },
      {
        name: 'request timeout',
        nested: {
          code: 'TIMEOUT',
          message: 'timeout (requestBody="{}", timeout=120000)',
        },
        expected: false,
      },
      {
        name: 'HTTP 429 rate limit',
        nested: {
          code: 'SERVER_ERROR',
          message:
            'bad response (status=429, headers={}, body="Too Many Requests")',
          status: 429,
        },
        expected: false,
      },
      {
        name: 'JSON-RPC rate limit error',
        nested: Object.assign(new Error('rate limit exceeded'), {
          code: -32005,
        }),
        expected: false,
      },
      {
        name: 'nested data 0x with header not found',
        nested: Object.assign(new Error('header not found'), {
          code: -32000,
          data: '0x',
        }),
        expected: false,
      },
      {
        name: 'nested empty-string data with HTTP 429',
        nested: {
          code: 'SERVER_ERROR',
          message:
            'bad response (status=429, headers={}, body="Too Many Requests")',
          status: 429,
          data: '',
        },
        expected: false,
      },
      {
        name: 'nested data 0x with an HTTP 500 body',
        nested: {
          code: 'SERVER_ERROR',
          message: 'processing response error',
          body: 'Internal Server Error',
          status: 500,
          data: '0x',
        },
        expected: false,
      },
      {
        name: 'nested data 0x with JSON-RPC code 3',
        nested: Object.assign(new Error('execution reverted'), {
          code: 3,
          data: '0x',
        }),
        expected: true,
      },
      // Captured from https://rpc.fuse.io (Nethermind 1.29.0) for an unknown
      // selector sent to a deployed Mailbox.
      {
        name: 'Nethermind -32015 revert with a supplied-gas data string',
        nested: {
          error: {
            code: -32015,
            message: 'VM execution error.',
            data: 'err: revert (supplied gas 20000000)',
          },
        },
        expected: true,
      },
      // Captured from https://fuse.liquify.com (Nethermind 1.29.0).
      {
        name: 'Nethermind -32015 revert with a bare revert data string',
        nested: {
          error: {
            code: -32015,
            message: 'VM execution error.',
            data: 'revert',
          },
        },
        expected: true,
      },
      // Captured from https://rpc.fuse.io and https://fuse.liquify.com.
      {
        name: 'Nethermind -32015 out of gas',
        nested: {
          error: {
            code: -32015,
            message: 'VM execution error.',
            data: 'err: OutOfGas (supplied gas 30000)',
          },
        },
        expected: false,
      },
      // Captured from https://fuse.liquify.com for eth_call against code 0xfe.
      {
        name: 'Nethermind -32015 invalid instruction',
        nested: {
          error: {
            code: -32015,
            message: 'VM execution error.',
            data: 'err: BadInstruction (supplied gas 20000000)',
          },
        },
        expected: false,
      },
      {
        name: 'revert data string under a non-Nethermind code',
        nested: {
          error: { code: -32005, message: 'rate limit', data: 'revert' },
        },
        expected: false,
      },
      // Captured from https://ethereum.publicnode.com (Geth 1.17.1) for eth_call
      // against code 0xfe and against an infinite loop with a 30000 gas cap.
      {
        name: 'Geth invalid opcode',
        nested: Object.assign(new Error('invalid opcode: INVALID'), {
          code: -32000,
        }),
        expected: false,
      },
      {
        name: 'Geth out of gas',
        nested: Object.assign(new Error('out of gas'), { code: -32000 }),
        expected: false,
      },
    ];

    for (const c of cases) {
      it(`returns ${c.expected} for ${c.name}`, () => {
        const error = ethersCallExceptionWithNestedError(c.nested);
        expect(isMissingSelectorCallException(error)).to.equal(c.expected);
        expect(isMissingSelectorRevert(error)).to.equal(c.expected);
        expect(isMissingSelectorCallException(wrappedError(error))).to.equal(
          c.expected,
        );
      });
    }
  });

  describe('isMissingSelectorRevert empty-data signals', () => {
    interface Case {
      name: string;
      error: () => unknown;
      expected: boolean;
    }

    const cases: Case[] = [
      {
        name: 'nested error reporting data 0x without top-level data',
        error: () => ({ code: 'CALL_EXCEPTION', error: { data: '0x' } }),
        expected: true,
      },
      {
        name: 'nested error data 0x alongside a non-revert message and no code',
        error: () =>
          ethersCallExceptionWithNestedError(
            Object.assign(new Error('boom'), { data: '0x' }),
          ),
        expected: false,
      },
      {
        name: 'nested transport message ECONNRESET with data 0x',
        error: () => ({
          code: 'CALL_EXCEPTION',
          error: { message: 'ECONNRESET', data: '0x' },
        }),
        expected: false,
      },
      {
        name: 'nested transport message socket hang up with empty-string data',
        error: () => ({
          code: 'CALL_EXCEPTION',
          error: { message: 'socket hang up', data: '' },
        }),
        expected: false,
      },
      {
        name: 'nested error reporting empty-string data',
        error: () => ({ code: 'CALL_EXCEPTION', error: { data: '' } }),
        expected: true,
      },
      {
        name: 'nested error data 0x with SERVER_ERROR and no message',
        error: () => ({
          code: 'CALL_EXCEPTION',
          error: { code: 'SERVER_ERROR', data: '0x' },
        }),
        expected: false,
      },
      {
        name: 'nested error data "" with HTTP 429 status',
        error: () => ({
          code: 'CALL_EXCEPTION',
          error: { code: 'SERVER_ERROR', status: 429, data: '' },
        }),
        expected: false,
      },
      {
        name: 'top-level empty-string data without nested error',
        error: () => ({ code: 'CALL_EXCEPTION', data: '' }),
        expected: true,
      },
      {
        name: 'top-level empty-string data with nested transport error',
        error: () => ({
          code: 'CALL_EXCEPTION',
          data: '',
          error: { code: 'SERVER_ERROR', status: 500 },
        }),
        expected: false,
      },
      {
        name: 'message-only data="0x" without nested error',
        error: () => ({
          code: 'CALL_EXCEPTION',
          message: 'call reverted with data="0x"',
        }),
        expected: true,
      },
      {
        name: 'message data="0x" with nested transport error',
        error: () =>
          ethersCallExceptionWithNestedError(
            Object.assign(new Error('header not found'), { code: -32000 }),
          ),
        expected: false,
      },
      {
        name: 'message data="0x" with nested HTTP 500 and no top-level data',
        error: () => ({
          code: 'CALL_EXCEPTION',
          message: 'call reverted with data="0x"',
          error: { code: 'SERVER_ERROR', status: 500 },
        }),
        expected: false,
      },
      {
        name: 'non-empty revert data',
        error: () => ({ code: 'CALL_EXCEPTION', data: '0x08c379a0abcd' }),
        expected: false,
      },
    ];

    for (const c of cases) {
      it(`returns ${c.expected} for ${c.name}`, () => {
        expect(isMissingSelectorRevert(c.error())).to.equal(c.expected);
        expect(isMissingSelectorCallException(c.error())).to.equal(c.expected);
      });
    }
  });

  describe('isReturnDataEmpty', () => {
    interface Case {
      name: string;
      data: unknown;
      expected: boolean;
    }

    const cases: Case[] = [
      { name: '0x', data: '0x', expected: true },
      { name: 'empty string', data: '', expected: true },
      { name: '0x0', data: '0x0', expected: false },
      { name: 'undefined', data: undefined, expected: false },
      { name: 'null', data: null, expected: false },
      { name: 'a number', data: 0, expected: false },
      { name: 'non-empty hex', data: '0x08c379a0', expected: false },
    ];

    for (const c of cases) {
      it(`returns ${c.expected} for ${c.name}`, () => {
        expect(isReturnDataEmpty(c.data)).to.equal(c.expected);
      });
    }
  });

  describe('isPanicRevert', () => {
    interface Case {
      name: string;
      error: () => unknown;
      expected: boolean;
    }

    const cases: Case[] = [
      { name: 'panic revert', error: panicRevertError, expected: true },
      {
        name: 'wrapped panic revert',
        error: () => wrappedError(panicRevertError()),
        expected: true,
      },
      {
        name: 'panic data on nested error.data',
        error: () =>
          Object.assign(new Error('call revert exception'), {
            code: 'CALL_EXCEPTION',
            error: { data: `0x4e487b71${'0'.repeat(62)}11` },
          }),
        expected: true,
      },
      {
        name: 'Error(string) revert',
        error: errorStringRevertError,
        expected: false,
      },
      {
        name: 'LSP17 no-extension revert',
        error: lsp17NoExtensionError,
        expected: false,
      },
      {
        name: 'empty data (missing selector)',
        error: missingSelectorError,
        expected: false,
      },
      { name: 'network error', error: networkError, expected: false },
      {
        name: 'empty provider response',
        error: () => new Error('Invalid response from provider'),
        expected: false,
      },
      {
        name: 'data shorter than the Panic selector',
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
            data: '0x4e487b71zz',
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
        expect(isPanicRevert(c.error())).to.equal(c.expected);
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
