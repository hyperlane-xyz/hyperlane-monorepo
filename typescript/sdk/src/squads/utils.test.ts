import { expect } from 'chai';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { accounts } from '@sqds/multisig';

import {
  SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  SquadTxStatus,
  SquadsAccountType,
  SQUADS_DISCRIMINATOR_SIZE,
  SquadsInstructionName,
  SquadsInstructionType,
  SQUADS_INSTRUCTION_DISCRIMINATORS,
  SQUADS_PROPOSAL_OVERHEAD,
  SquadsProposalVoteError,
  SquadsPermission,
  SquadsProposalStatus,
  SQUADS_ACCOUNT_DISCRIMINATORS,
  decodePermissions,
  executeProposal,
  assertValidTransactionIndexInput,
  getSquadAndProvider,
  getPendingProposalsForChains,
  getMinimumProposalIndexToCheck,
  isLikelyMissingSquadsAccountError,
  normalizeSquadsAddressList,
  normalizeSquadsAddressValue,
  parseSquadsMultisigMembers,
  getSquadProposalAccount,
  getSquadProposal,
  getSquadTxStatus,
  buildSquadsVaultTransactionProposal,
  submitProposalToSquads,
  isTerminalSquadsProposalStatus,
  canModifySquadsProposalStatus,
  deriveSquadsProposalModification,
  isStaleSquadsProposal,
  shouldTrackPendingSquadsProposal,
  getTransactionType,
  isConfigTransaction,
  parseSquadsProposalVoteError,
  parseSquadsProposalVoteErrorFromError,
  parseSquadMultisig,
  parseSquadProposal,
  parseSquadProposalTransactionIndex,
  isVaultTransaction,
  buildSquadsProposalCancellation,
  buildSquadsProposalRejection,
} from './utils.js';
import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import {
  assertIsSquadsChain,
  getUnsupportedSquadsChainsErrorMessage,
  getSquadsChains,
  getSquadsKeys,
  isSquadsChain,
  partitionSquadsChains,
  resolveSquadsChains,
  squadsConfigs,
} from './config.js';

function captureSyncError(fn: () => void): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

async function captureAsyncError(
  fn: () => Promise<unknown>,
): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

function createErrorWithUnformattableMessage(): Error {
  const error = new Error('boom');
  Object.defineProperty(error, 'message', {
    configurable: true,
    get() {
      throw new Error('message unavailable');
    },
  });
  return error;
}

function createErrorWithGenericObjectStringification(): Error {
  const error = new Error('boom');
  Object.defineProperty(error, 'message', {
    configurable: true,
    get() {
      return '';
    },
  });
  error.toString = () => '[object ErrorLike]';
  return error;
}

function createUnstringifiableObjectErrorWithMessage(message: string): {
  message: string;
  toString: () => string;
} {
  return {
    message,
    toString: () => {
      throw new Error('unable to stringify');
    },
  };
}

function createUnstringifiableObjectErrorWithStackAndMessage(
  stack: string,
  message: string,
): { stack: string; message: string; toString: () => string } {
  return {
    stack,
    message,
    toString: () => {
      throw new Error('unable to stringify');
    },
  };
}

function createUnstringifiableObjectErrorWithThrowingStackGetter(
  message: string,
): { message: string; toString: () => string; stack?: string } {
  const errorLikeObject = {
    message,
    toString: () => {
      throw new Error('unable to stringify');
    },
  } as { message: string; toString: () => string; stack?: string };
  Object.defineProperty(errorLikeObject, 'stack', {
    configurable: true,
    get() {
      throw new Error('stack unavailable');
    },
  });
  return errorLikeObject;
}

function createStringifiableObjectErrorWithThrowingStackAndMessageGetters(
  stringifiedValue: string,
): { toString: () => string; stack?: string; message?: string } {
  const errorLikeObject = {
    toString: () => stringifiedValue,
  } as { toString: () => string; stack?: string; message?: string };
  Object.defineProperty(errorLikeObject, 'stack', {
    configurable: true,
    get() {
      throw new Error('stack unavailable');
    },
  });
  Object.defineProperty(errorLikeObject, 'message', {
    configurable: true,
    get() {
      throw new Error('message unavailable');
    },
  });
  return errorLikeObject;
}

describe('squads utils', () => {
  describe(normalizeSquadsAddressValue.name, () => {
    it('normalizes valid Solana address strings', () => {
      expect(
        normalizeSquadsAddressValue(' 11111111111111111111111111111111 '),
      ).to.deep.equal({
        address: '11111111111111111111111111111111',
        error: undefined,
      });
    });

    it('normalizes valid object addresses via toBase58()', () => {
      expect(
        normalizeSquadsAddressValue({
          toBase58: () => '11111111111111111111111111111111',
        }),
      ).to.deep.equal({
        address: '11111111111111111111111111111111',
        error: undefined,
      });
    });

    it('rejects empty Solana address strings', () => {
      expect(normalizeSquadsAddressValue('   ')).to.deep.equal({
        address: undefined,
        error: 'address value is empty',
      });
    });

    it('rejects generic object label strings', () => {
      expect(normalizeSquadsAddressValue('[object Object]')).to.deep.equal({
        address: undefined,
        error: 'address value is not a meaningful identifier',
      });
    });

    it('rejects non-address Solana string values', () => {
      expect(normalizeSquadsAddressValue('not-an-address')).to.deep.equal({
        address: undefined,
        error: 'address value is not a valid Solana address',
      });
    });

    it('rejects primitive values that are not strings', () => {
      expect(normalizeSquadsAddressValue(123)).to.deep.equal({
        address: undefined,
        error: 'expected string or object with toBase58(), got number',
      });
    });

    it('labels array values clearly when rejecting non-string primitives', () => {
      expect(normalizeSquadsAddressValue([])).to.deep.equal({
        address: undefined,
        error: 'expected string or object with toBase58(), got array',
      });
    });

    it('labels null values clearly when rejecting non-string primitives', () => {
      expect(normalizeSquadsAddressValue(null)).to.deep.equal({
        address: undefined,
        error: 'expected string or object with toBase58(), got null',
      });
    });

    const unsupportedPrimitiveInputCases: Array<{
      title: string;
      value: unknown;
      expectedType: string;
    }> = [
      {
        title:
          'labels undefined values clearly when rejecting non-string primitives',
        value: undefined,
        expectedType: 'undefined',
      },
      {
        title:
          'labels boolean values clearly when rejecting non-string primitives',
        value: false,
        expectedType: 'boolean',
      },
      {
        title:
          'labels bigint values clearly when rejecting non-string primitives',
        value: 1n,
        expectedType: 'bigint',
      },
      {
        title:
          'labels symbol values clearly when rejecting non-string primitives',
        value: Symbol('bad-address'),
        expectedType: 'symbol',
      },
      {
        title:
          'labels function values clearly when rejecting non-string primitives',
        value: () => '11111111111111111111111111111111',
        expectedType: 'function',
      },
    ];

    for (const {
      title,
      value,
      expectedType,
    } of unsupportedPrimitiveInputCases) {
      it(title, () => {
        expect(normalizeSquadsAddressValue(value)).to.deep.equal({
          address: undefined,
          error: `expected string or object with toBase58(), got ${expectedType}`,
        });
      });
    }

    it('rejects objects missing toBase58()', () => {
      expect(normalizeSquadsAddressValue({})).to.deep.equal({
        address: undefined,
        error: 'missing toBase58() method',
      });
    });

    it('reports stringification failures from toBase58()', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw new Error('boom');
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.include('failed to stringify key');
      expect(result.error).to.include('boom');
    });

    it('reports toBase58 getter read failures', () => {
      const addressLike = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'toBase58') {
              throw new Error('getter unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const result = normalizeSquadsAddressValue(addressLike);

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to read toBase58() method (getter unavailable)',
      );
    });

    it('uses message fields when toBase58 throws unstringifiable objects', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw createUnstringifiableObjectErrorWithMessage('boom');
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal('failed to stringify key (boom)');
    });

    it('uses stack fields when toBase58 throws unstringifiable objects with stack', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw createUnstringifiableObjectErrorWithStackAndMessage(
            'Error: boom\n at sample.ts:1:1',
            'boom',
          );
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to stringify key (Error: boom\n at sample.ts:1:1)',
      );
    });

    it('falls back to message when stack accessor throws during toBase58 failures', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw createUnstringifiableObjectErrorWithThrowingStackGetter('boom');
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal('failed to stringify key (boom)');
    });

    it('falls back to message when stack is whitespace-only during toBase58 failures', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw {
            stack: '   ',
            message: 'boom',
            toString() {
              return 'should not be used';
            },
          };
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal('failed to stringify key (boom)');
    });

    it('falls back to String(error) when stack/message accessors throw during toBase58 failures', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw createStringifiableObjectErrorWithThrowingStackAndMessageGetters(
            'custom error',
          );
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal('failed to stringify key (custom error)');
    });

    it('uses placeholder when String(error) fallback normalizes to empty text', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw createStringifiableObjectErrorWithThrowingStackAndMessageGetters(
            '   ',
          );
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to stringify key ([unstringifiable error])',
      );
    });

    it('uses placeholder when toBase58 throws whitespace-only string errors', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw '   ';
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to stringify key ([unstringifiable error])',
      );
    });

    it('uses placeholder when toBase58 throws bare Error labels', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw new Error('');
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to stringify key ([unstringifiable error])',
      );
    });

    it('uses placeholder when toBase58 throws bare TypeError labels', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw new TypeError('');
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to stringify key ([unstringifiable error])',
      );
    });

    it('preserves custom Error-like labels when toBase58 throws string errors', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw 'RpcError';
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal('failed to stringify key (RpcError)');
    });

    it('uses placeholder when toBase58 throws generic object errors', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw {};
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to stringify key ([unstringifiable error])',
      );
    });

    it('uses placeholder when toBase58 throws generic-stringified Error values', () => {
      const result = normalizeSquadsAddressValue({
        toBase58() {
          throw createErrorWithGenericObjectStringification();
        },
      });

      expect(result.address).to.equal(undefined);
      expect(result.error).to.equal(
        'failed to stringify key ([unstringifiable error])',
      );
    });

    it('rejects generic object identifiers returned by toBase58()', () => {
      expect(
        normalizeSquadsAddressValue({
          toBase58: () => ({}) as unknown,
        }),
      ).to.deep.equal({
        address: undefined,
        error: 'address value is not a meaningful identifier',
      });
    });
  });

  describe(normalizeSquadsAddressList.name, () => {
    it('collects normalized addresses and counts invalid entries', () => {
      expect(
        normalizeSquadsAddressList([
          '11111111111111111111111111111111',
          { toBase58: () => '11111111111111111111111111111111' },
          null,
          'not-an-address',
        ]),
      ).to.deep.equal({
        addresses: [
          '11111111111111111111111111111111',
          '11111111111111111111111111111111',
        ],
        invalidEntries: 2,
      });
    });

    it('returns empty address list for fully invalid input', () => {
      expect(normalizeSquadsAddressList([null, 1, 'bad'])).to.deep.equal({
        addresses: [],
        invalidEntries: 3,
      });
    });

    it('throws for malformed non-array address-list inputs', () => {
      expect(() => normalizeSquadsAddressList('not-array')).to.throw(
        'Expected address list to be an array, got string',
      );
      expect(() => normalizeSquadsAddressList(null)).to.throw(
        'Expected address list to be an array, got null',
      );
    });

    it('counts entries as invalid when array element access throws', () => {
      const hostileAddressList = new Proxy(
        [
          '11111111111111111111111111111111',
          '11111111111111111111111111111111',
        ],
        {
          get(target, property, receiver) {
            if (property === '1') {
              throw new Error('entry unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(normalizeSquadsAddressList(hostileAddressList)).to.deep.equal({
        addresses: ['11111111111111111111111111111111'],
        invalidEntries: 1,
      });
    });

    it('throws stable error when address list length accessor fails', () => {
      const hostileAddressList = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('length unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() => normalizeSquadsAddressList(hostileAddressList)).to.throw(
        'Failed to read address list length: length unavailable',
      );
    });

    it('throws stable error when address list length is malformed', () => {
      const hostileAddressList = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') {
            return 1n;
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() => normalizeSquadsAddressList(hostileAddressList)).to.throw(
        'Malformed address list length: expected non-negative safe integer, got bigint',
      );
    });
  });

  describe(parseSquadsMultisigMembers.name, () => {
    it('parses multisig members with normalized keys and permissions', () => {
      expect(
        parseSquadsMultisigMembers([
          {
            key: '11111111111111111111111111111111',
            permissions: 7,
          },
          {
            key: { toBase58: () => '11111111111111111111111111111111' },
          },
        ]),
      ).to.deep.equal({
        members: [
          {
            key: '11111111111111111111111111111111',
            permissions: 7,
          },
          {
            key: '11111111111111111111111111111111',
            permissions: null,
          },
        ],
        invalidEntries: 0,
      });
    });

    it('counts invalid multisig member entries', () => {
      expect(
        parseSquadsMultisigMembers([
          null,
          { permissions: 7 },
          { key: 'not-an-address' },
        ]),
      ).to.deep.equal({
        members: [],
        invalidEntries: 3,
      });
    });

    it('throws for malformed non-array multisig-member inputs', () => {
      expect(() => parseSquadsMultisigMembers('not-array')).to.throw(
        'Expected multisig members to be an array, got string',
      );
      expect(() => parseSquadsMultisigMembers(null)).to.throw(
        'Expected multisig members to be an array, got null',
      );
    });

    it('throws contextual error when members length getter throws', () => {
      const hostileMembers = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('members length unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() => parseSquadsMultisigMembers(hostileMembers)).to.throw(
        'Failed to read multisig members length: members length unavailable',
      );
    });

    it('throws contextual error when members length type is malformed', () => {
      const hostileMembers = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') {
            return 1n;
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() => parseSquadsMultisigMembers(hostileMembers)).to.throw(
        'Malformed multisig members length: expected non-negative safe integer, got bigint',
      );
    });

    it('counts members as invalid when member index access throws', () => {
      const hostileMembers = new Proxy(
        [{ key: '11111111111111111111111111111111' }],
        {
          get(target, property, receiver) {
            if (property === '0') {
              throw new Error('member entry unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(parseSquadsMultisigMembers(hostileMembers)).to.deep.equal({
        members: [],
        invalidEntries: 1,
      });
    });

    it('counts members as invalid when member key getter throws', () => {
      const hostileMember = new Proxy(
        { permissions: 7 },
        {
          get(target, property, receiver) {
            if (property === 'key') {
              throw new Error('key unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(
        parseSquadsMultisigMembers([
          hostileMember,
          { key: '11111111111111111111111111111111', permissions: 3 },
        ]),
      ).to.deep.equal({
        members: [
          {
            key: '11111111111111111111111111111111',
            permissions: 3,
          },
        ],
        invalidEntries: 1,
      });
    });

    it('keeps member entry when permissions getter throws', () => {
      const hostileMember = new Proxy(
        { key: '11111111111111111111111111111111' },
        {
          get(target, property, receiver) {
            if (property === 'permissions') {
              throw new Error('permissions unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(parseSquadsMultisigMembers([hostileMember])).to.deep.equal({
        members: [
          {
            key: '11111111111111111111111111111111',
            permissions: null,
          },
        ],
        invalidEntries: 0,
      });
    });
  });

  describe(isLikelyMissingSquadsAccountError.name, () => {
    it('detects likely missing-account error messages', () => {
      expect(
        isLikelyMissingSquadsAccountError(
          'Error: Account does not exist 11111111111111111111111111111111',
        ),
      ).to.equal(true);
      expect(
        isLikelyMissingSquadsAccountError(
          new Error('failed to find account for address'),
        ),
      ).to.equal(true);
      expect(
        isLikelyMissingSquadsAccountError(
          'rpc response: account not found for pubkey',
        ),
      ).to.equal(true);
    });

    it('returns false for non-missing-account errors', () => {
      expect(
        isLikelyMissingSquadsAccountError('provider lookup failed'),
      ).to.equal(false);
      expect(
        isLikelyMissingSquadsAccountError(
          new Error('timeout while fetching account'),
        ),
      ).to.equal(false);
    });

    it('handles unstringifiable error objects safely', () => {
      const unstringifiableError = {
        [Symbol.toPrimitive]() {
          throw new Error('cannot stringify');
        },
      };

      expect(() =>
        isLikelyMissingSquadsAccountError(unstringifiableError),
      ).to.not.throw();
      expect(isLikelyMissingSquadsAccountError(unstringifiableError)).to.equal(
        false,
      );
    });
  });

  describe(assertValidTransactionIndexInput.name, () => {
    it('accepts non-negative safe integer transaction indices', () => {
      expect(() =>
        assertValidTransactionIndexInput(0, 'solanamainnet'),
      ).to.not.throw();
      expect(() =>
        assertValidTransactionIndexInput(42, 'solanamainnet'),
      ).to.not.throw();
      expect(assertValidTransactionIndexInput(7, 'solanamainnet')).to.equal(7);
    });

    it('normalizes chain labels in transaction-index validation errors', () => {
      expect(() =>
        assertValidTransactionIndexInput(-1, '  solanamainnet  '),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got -1',
      );
      expect(() => assertValidTransactionIndexInput(-1, '   ')).to.throw(
        'Expected transaction index to be a non-negative safe integer for empty string, got -1',
      );
    });

    it('labels malformed chain values in transaction-index validation errors', () => {
      expect(() => assertValidTransactionIndexInput(-1, null)).to.throw(
        'Expected transaction index to be a non-negative safe integer for null, got -1',
      );
      expect(() => assertValidTransactionIndexInput(-1, [])).to.throw(
        'Expected transaction index to be a non-negative safe integer for array, got -1',
      );
    });

    it('throws for invalid transaction indices', () => {
      expect(() =>
        assertValidTransactionIndexInput(-1, 'solanamainnet'),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got -1',
      );
      expect(() =>
        assertValidTransactionIndexInput(Number.NaN, 'solanamainnet'),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got NaN',
      );
      expect(() =>
        assertValidTransactionIndexInput('1', 'solanamainnet'),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got string',
      );
      expect(() =>
        assertValidTransactionIndexInput(null, 'solanamainnet'),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got null',
      );
      expect(() =>
        assertValidTransactionIndexInput([], 'solanamainnet'),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got array',
      );
      expect(() =>
        assertValidTransactionIndexInput(1n, 'solanamainnet'),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got bigint',
      );
      expect(() =>
        assertValidTransactionIndexInput(Symbol('index'), 'solanamainnet'),
      ).to.throw(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got symbol',
      );
    });
  });

  describe(getMinimumProposalIndexToCheck.name, () => {
    it('includes transaction index zero in search range', () => {
      expect(getMinimumProposalIndexToCheck(0)).to.equal(0);
    });

    it('clamps minimum index to zero for small indices', () => {
      expect(getMinimumProposalIndexToCheck(5, 10)).to.equal(0);
    });

    it('subtracts lookback count for larger indices', () => {
      expect(getMinimumProposalIndexToCheck(25, 10)).to.equal(15);
    });

    it('returns current index when lookback count is zero', () => {
      expect(getMinimumProposalIndexToCheck(25, 0)).to.equal(25);
    });

    it('returns zero when current index equals lookback count', () => {
      expect(getMinimumProposalIndexToCheck(10, 10)).to.equal(0);
    });

    it('handles near-max safe integer indices without precision loss', () => {
      expect(
        getMinimumProposalIndexToCheck(Number.MAX_SAFE_INTEGER, 10),
      ).to.equal(Number.MAX_SAFE_INTEGER - 10);
    });

    it('throws for negative current transaction index', () => {
      expect(() => getMinimumProposalIndexToCheck(-1)).to.throw(
        'Expected current transaction index to be a non-negative safe integer, got -1',
      );
    });

    it('throws for non-integer current transaction index', () => {
      expect(() => getMinimumProposalIndexToCheck(1.5)).to.throw(
        'Expected current transaction index to be a non-negative safe integer, got 1.5',
      );
    });

    it('throws for non-safe current transaction index', () => {
      expect(() =>
        getMinimumProposalIndexToCheck(Number.MAX_SAFE_INTEGER + 1),
      ).to.throw(
        `Expected current transaction index to be a non-negative safe integer, got ${
          Number.MAX_SAFE_INTEGER + 1
        }`,
      );
    });

    it('throws for infinite current transaction index', () => {
      expect(() =>
        getMinimumProposalIndexToCheck(Number.POSITIVE_INFINITY),
      ).to.throw(
        'Expected current transaction index to be a non-negative safe integer, got Infinity',
      );
    });

    it('throws for malformed non-number current transaction index', () => {
      expect(() => getMinimumProposalIndexToCheck('1')).to.throw(
        'Expected current transaction index to be a non-negative safe integer, got string',
      );
      expect(() => getMinimumProposalIndexToCheck(null)).to.throw(
        'Expected current transaction index to be a non-negative safe integer, got null',
      );
    });

    it('throws for negative lookback count', () => {
      expect(() => getMinimumProposalIndexToCheck(1, -1)).to.throw(
        'Expected lookback count to be a non-negative safe integer, got -1',
      );
    });

    it('throws for non-integer lookback count', () => {
      expect(() => getMinimumProposalIndexToCheck(1, 0.5)).to.throw(
        'Expected lookback count to be a non-negative safe integer, got 0.5',
      );
    });

    it('throws for infinite lookback count', () => {
      expect(() =>
        getMinimumProposalIndexToCheck(1, Number.POSITIVE_INFINITY),
      ).to.throw(
        'Expected lookback count to be a non-negative safe integer, got Infinity',
      );
    });

    it('throws for malformed non-number lookback count', () => {
      expect(() => getMinimumProposalIndexToCheck(1, '1')).to.throw(
        'Expected lookback count to be a non-negative safe integer, got string',
      );
      expect(() => getMinimumProposalIndexToCheck(1, null)).to.throw(
        'Expected lookback count to be a non-negative safe integer, got null',
      );
    });
  });

  describe(getSquadTxStatus.name, () => {
    it('returns draft for draft proposal', () => {
      expect(getSquadTxStatus('Draft', 0, 3, 12, 10)).to.equal(
        SquadTxStatus.DRAFT,
      );
    });

    it('returns stale for stale non-executed proposal', () => {
      expect(getSquadTxStatus('Active', 0, 2, 5, 10)).to.equal(
        SquadTxStatus.STALE,
      );
    });

    it('returns stale for stale draft proposal', () => {
      expect(getSquadTxStatus('Draft', 0, 2, 5, 10)).to.equal(
        SquadTxStatus.STALE,
      );
    });

    it('returns stale for stale approved proposal', () => {
      expect(getSquadTxStatus('Approved', 2, 2, 5, 10)).to.equal(
        SquadTxStatus.STALE,
      );
    });

    it('returns stale for stale executing proposal', () => {
      expect(getSquadTxStatus('Executing', 2, 2, 5, 10)).to.equal(
        SquadTxStatus.STALE,
      );
    });

    it('returns one-away status for active proposal', () => {
      expect(getSquadTxStatus('Active', 2, 3, 12, 10)).to.equal(
        SquadTxStatus.ONE_AWAY,
      );
    });

    it('returns approved for active proposal at threshold', () => {
      expect(getSquadTxStatus('Active', 3, 3, 12, 10)).to.equal(
        SquadTxStatus.APPROVED,
      );
    });

    it('returns executed for executed proposal', () => {
      expect(getSquadTxStatus('Executed', 3, 3, 9, 10)).to.equal(
        SquadTxStatus.EXECUTED,
      );
    });

    it('returns rejected for rejected proposal', () => {
      expect(getSquadTxStatus('Rejected', 0, 3, 12, 10)).to.equal(
        SquadTxStatus.REJECTED,
      );
    });

    it('returns approved for approved proposal status', () => {
      expect(getSquadTxStatus('Approved', 0, 3, 12, 10)).to.equal(
        SquadTxStatus.APPROVED,
      );
    });

    it('returns executing for executing proposal', () => {
      expect(getSquadTxStatus('Executing', 3, 3, 12, 10)).to.equal(
        SquadTxStatus.EXECUTING,
      );
    });

    it('returns cancelled for cancelled proposal', () => {
      expect(getSquadTxStatus('Cancelled', 0, 3, 12, 10)).to.equal(
        SquadTxStatus.CANCELLED,
      );
    });

    it('does not mark rejected proposals as stale', () => {
      expect(getSquadTxStatus('Rejected', 0, 3, 1, 10)).to.equal(
        SquadTxStatus.REJECTED,
      );
    });

    it('does not mark cancelled proposals as stale', () => {
      expect(getSquadTxStatus('Cancelled', 0, 3, 1, 10)).to.equal(
        SquadTxStatus.CANCELLED,
      );
    });

    it('returns unknown for unexpected proposal status values', () => {
      expect(
        getSquadTxStatus(
          'UnexpectedStatus' as unknown as SquadsProposalStatus,
          0,
          1,
          1,
          0,
        ),
      ).to.equal(SquadTxStatus.UNKNOWN);
    });

    it('normalizes surrounding whitespace on known statuses', () => {
      expect(getSquadTxStatus(' Active ', 1, 3, 12, 10)).to.equal(
        SquadTxStatus.ACTIVE,
      );
    });

    it('throws for zero threshold values', () => {
      expect(() => getSquadTxStatus('Active', 0, 0, 1, 0)).to.throw(
        'Expected threshold to be a positive safe integer, got 0',
      );
    });

    it('throws for negative approval counts', () => {
      expect(() => getSquadTxStatus('Active', -1, 1, 1, 0)).to.throw(
        'Expected approvals to be a non-negative safe integer, got -1',
      );
    });

    it('throws for fractional approval counts', () => {
      expect(() => getSquadTxStatus('Active', 1.5, 2, 1, 0)).to.throw(
        'Expected approvals to be a non-negative safe integer, got 1.5',
      );
    });

    it('throws for malformed non-number approval counts', () => {
      expect(() => getSquadTxStatus('Active', '1', 2, 1, 0)).to.throw(
        'Expected approvals to be a non-negative safe integer, got string',
      );
      expect(() => getSquadTxStatus('Active', null, 2, 1, 0)).to.throw(
        'Expected approvals to be a non-negative safe integer, got null',
      );
    });

    it('throws for unsafe threshold values', () => {
      const unsafeThreshold = Number.MAX_SAFE_INTEGER + 1;
      expect(() =>
        getSquadTxStatus('Active', 0, unsafeThreshold, 1, 0),
      ).to.throw(
        `Expected threshold to be a positive safe integer, got ${unsafeThreshold}`,
      );
    });

    it('throws for malformed non-number threshold values', () => {
      expect(() => getSquadTxStatus('Active', 0, '1', 1, 0)).to.throw(
        'Expected threshold to be a positive safe integer, got string',
      );
      expect(() => getSquadTxStatus('Active', 0, null, 1, 0)).to.throw(
        'Expected threshold to be a positive safe integer, got null',
      );
    });

    it('throws for negative stale transaction index values', () => {
      expect(() => getSquadTxStatus('Active', 0, 1, 1, -1)).to.throw(
        'Expected stale transaction index to be a non-negative safe integer, got -1',
      );
    });

    it('throws for fractional transaction index values', () => {
      expect(() => getSquadTxStatus('Active', 0, 1, 1.5, 0)).to.throw(
        'Expected transaction index to be a non-negative safe integer, got 1.5',
      );
    });

    it('throws for malformed non-number transaction index values', () => {
      expect(() => getSquadTxStatus('Active', 0, 1, '1', 0)).to.throw(
        'Expected transaction index to be a non-negative safe integer, got string',
      );
      expect(() => getSquadTxStatus('Active', 0, 1, null, 0)).to.throw(
        'Expected transaction index to be a non-negative safe integer, got null',
      );
    });

    it('throws for malformed non-number stale transaction index values', () => {
      expect(() => getSquadTxStatus('Active', 0, 1, 1, '0')).to.throw(
        'Expected stale transaction index to be a non-negative safe integer, got string',
      );
      expect(() => getSquadTxStatus('Active', 0, 1, 1, null)).to.throw(
        'Expected stale transaction index to be a non-negative safe integer, got null',
      );
    });

    it('throws for empty status strings', () => {
      expect(() => getSquadTxStatus('   ', 0, 1, 1, 0)).to.throw(
        'Expected status kind to be a non-empty string',
      );
    });

    it('throws for non-string status values', () => {
      expect(() => getSquadTxStatus(1, 0, 1, 1, 0)).to.throw(
        'Expected status kind to be a string, got number',
      );
    });
  });

  describe(parseSquadProposal.name, () => {
    it('throws when proposal container is not an object', () => {
      expect(() => parseSquadProposal(null)).to.throw(
        'Squads proposal must be an object, got null',
      );
      expect(() => parseSquadProposal([])).to.throw(
        'Squads proposal must be an object, got array',
      );
    });

    it('extracts status, vote counts, and numeric transaction index', () => {
      const parsed = parseSquadProposal({
        status: { __kind: SquadsProposalStatus.Active },
        approved: [{}, {}, {}],
        rejected: [{}],
        cancelled: [{}, {}],
        transactionIndex: 42n,
      } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parsed).to.deep.equal({
        status: SquadsProposalStatus.Active,
        approvals: 3,
        rejections: 1,
        cancellations: 2,
        transactionIndex: 42,
        statusTimestampSeconds: undefined,
      });
    });

    it('extracts numeric status timestamp when present', () => {
      const parsed = parseSquadProposal({
        status: { __kind: SquadsProposalStatus.Active, timestamp: 1700000000n },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: 7n,
      } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parsed).to.deep.equal({
        status: SquadsProposalStatus.Active,
        approvals: 0,
        rejections: 0,
        cancellations: 0,
        transactionIndex: 7,
        statusTimestampSeconds: 1700000000,
      });
    });

    it('preserves unknown status strings for forward compatibility', () => {
      const parsed = parseSquadProposal({
        status: { __kind: 'FutureStatus' },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: 7n,
      } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parsed.status).to.equal('FutureStatus');
      expect(
        getSquadTxStatus(
          parsed.status,
          parsed.approvals,
          1,
          parsed.transactionIndex,
          0,
        ),
      ).to.equal(SquadTxStatus.UNKNOWN);
    });

    it('normalizes unknown status strings by trimming whitespace', () => {
      const parsed = parseSquadProposal({
        status: { __kind: '  FutureStatus  ' },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: 7n,
      } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parsed.status).to.equal('FutureStatus');
      expect(
        getSquadTxStatus(
          parsed.status,
          parsed.approvals,
          1,
          parsed.transactionIndex,
          0,
        ),
      ).to.equal(SquadTxStatus.UNKNOWN);
    });

    it('normalizes status kind by trimming surrounding whitespace', () => {
      const parsed = parseSquadProposal({
        status: { __kind: ` ${SquadsProposalStatus.Active} ` },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: 7n,
      } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parsed.status).to.equal(SquadsProposalStatus.Active);
      expect(
        getSquadTxStatus(
          parsed.status,
          parsed.approvals,
          2,
          parsed.transactionIndex,
          0,
        ),
      ).to.equal(SquadTxStatus.ACTIVE);
    });

    it('accepts bignum-like proposal indexes and timestamps', () => {
      const parsed = parseSquadProposal({
        status: {
          __kind: SquadsProposalStatus.Active,
          timestamp: { toString: () => '1700000000' },
        },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: { toString: () => '7' },
      } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parsed).to.deep.equal({
        status: SquadsProposalStatus.Active,
        approvals: 0,
        rejections: 0,
        cancellations: 0,
        transactionIndex: 7,
        statusTimestampSeconds: 1700000000,
      });
    });

    it('accepts proposal indexes and timestamps that stringify via Symbol.toPrimitive', () => {
      const parsed = parseSquadProposal({
        status: {
          __kind: SquadsProposalStatus.Active,
          timestamp: {
            [Symbol.toPrimitive]: () => '1700000001',
          },
        },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: {
          [Symbol.toPrimitive]: () => '8',
        },
      } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parsed).to.deep.equal({
        status: SquadsProposalStatus.Active,
        approvals: 0,
        rejections: 0,
        cancellations: 0,
        transactionIndex: 8,
        statusTimestampSeconds: 1700000001,
      });
    });

    it('throws when transaction index is not a safe integer', () => {
      const parseUnsafeProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseUnsafeProposal).to.throw(
        'Squads transaction index must be a JavaScript safe integer',
      );
    });

    it('throws when transaction index is boolean-like', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: true,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads transaction index must be a JavaScript safe integer: true',
      );
    });

    it('throws when transaction index is numeric string input', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: '7',
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads transaction index must be a JavaScript safe integer: 7',
      );
    });

    it('throws when transaction index is negative', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: -1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads transaction index must be a non-negative JavaScript safe integer: -1',
      );
    });

    it('throws when bignum-like transaction index is negative', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: { toString: () => '-1' },
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads transaction index must be a non-negative JavaScript safe integer: -1',
      );
    });

    it('throws when status timestamp is not a safe integer', () => {
      const parseUnsafeTimestampProposal = () =>
        parseSquadProposal({
          status: {
            __kind: SquadsProposalStatus.Active,
            timestamp: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: 9n,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseUnsafeTimestampProposal).to.throw(
        'Squads status timestamp must be a JavaScript safe integer',
      );
    });

    it('throws when status timestamp is negative', () => {
      const parseInvalidTimestampProposal = () =>
        parseSquadProposal({
          status: {
            __kind: SquadsProposalStatus.Active,
            timestamp: -1,
          },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: 9n,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidTimestampProposal).to.throw(
        'Squads status timestamp must be a non-negative JavaScript safe integer: -1',
      );
    });

    it('throws when approved votes field is not an array', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: 'not-an-array',
          rejected: [],
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal approved votes must be an array',
      );
    });

    it('throws contextual error when approved votes getter throws', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal(
          new Proxy(
            {
              status: { __kind: SquadsProposalStatus.Active },
              rejected: [],
              cancelled: [],
              transactionIndex: 1,
            },
            {
              get(target, property, receiver) {
                if (property === 'approved') {
                  throw new Error('approved unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ) as unknown as Parameters<typeof parseSquadProposal>[0],
        );

      expect(parseInvalidProposal).to.throw(
        'Failed to read Squads proposal approved votes: approved unavailable',
      );
    });

    it('throws contextual error when approved votes length getter throws', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: new Proxy([], {
            get(target, property, receiver) {
              if (property === 'length') {
                throw new Error('approved length unavailable');
              }
              return Reflect.get(target, property, receiver);
            },
          }),
          rejected: [],
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Failed to read Squads proposal approved votes length: approved length unavailable',
      );
    });

    it('throws when rejected votes field is not an array', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: 'not-an-array',
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal rejected votes must be an array',
      );
    });

    it('throws when cancelled votes field is missing', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal cancelled votes must be an array',
      );
    });

    it('throws when proposal status is not an object', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: 'invalid-status',
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal status must be an object',
      );
    });

    it('throws contextual error when proposal status getter throws', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal(
          new Proxy(
            {
              approved: [],
              rejected: [],
              cancelled: [],
              transactionIndex: 1,
            },
            {
              get(target, property, receiver) {
                if (property === 'status') {
                  throw new Error('status unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ) as unknown as Parameters<typeof parseSquadProposal>[0],
        );

      expect(parseInvalidProposal).to.throw(
        'Failed to read Squads proposal status: status unavailable',
      );
    });

    it('throws when proposal status kind is missing', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: {},
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal status kind must be a string',
      );
    });

    it('throws when proposal status kind is non-string', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: 123 },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal status kind must be a string',
      );
    });

    it('throws when proposal status kind is empty', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: '' },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal status kind must be a non-empty string',
      );
    });

    it('throws when proposal status kind is whitespace', () => {
      const parseInvalidProposal = () =>
        parseSquadProposal({
          status: { __kind: '   ' },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: 1,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseInvalidProposal).to.throw(
        'Squads proposal status kind must be a non-empty string',
      );
    });
  });

  describe(parseSquadProposalTransactionIndex.name, () => {
    it('throws when proposal container is not an object', () => {
      expect(() => parseSquadProposalTransactionIndex(null)).to.throw(
        'Squads proposal must be an object, got null',
      );
      expect(() => parseSquadProposalTransactionIndex([])).to.throw(
        'Squads proposal must be an object, got array',
      );
    });

    it('extracts non-negative transaction indices from valid proposals', () => {
      const transactionIndex = parseSquadProposalTransactionIndex({
        transactionIndex: 12n,
      } as unknown as Parameters<typeof parseSquadProposalTransactionIndex>[0]);

      expect(transactionIndex).to.equal(12);
    });

    it('accepts transaction index values that stringify via Symbol.toPrimitive', () => {
      const transactionIndex = parseSquadProposalTransactionIndex({
        transactionIndex: {
          [Symbol.toPrimitive]: () => '13',
        },
      } as unknown as Parameters<typeof parseSquadProposalTransactionIndex>[0]);

      expect(transactionIndex).to.equal(13);
    });

    it('throws when transaction index value is malformed', () => {
      const parseInvalidIndex = () =>
        parseSquadProposalTransactionIndex({
          transactionIndex: true,
        } as unknown as Parameters<
          typeof parseSquadProposalTransactionIndex
        >[0]);

      expect(parseInvalidIndex).to.throw(
        'Squads transaction index must be a JavaScript safe integer: true',
      );
    });

    it('throws contextual error when transaction index getter throws', () => {
      const parseInvalidIndex = () =>
        parseSquadProposalTransactionIndex(
          new Proxy(
            {},
            {
              get(target, property, receiver) {
                if (property === 'transactionIndex') {
                  throw new Error('index unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ) as unknown as Parameters<
            typeof parseSquadProposalTransactionIndex
          >[0],
        );

      expect(parseInvalidIndex).to.throw(
        'Failed to read Squads transaction index: index unavailable',
      );
    });

    it('throws when transaction index value is negative', () => {
      const parseNegativeIndex = () =>
        parseSquadProposalTransactionIndex({
          transactionIndex: -1,
        } as unknown as Parameters<
          typeof parseSquadProposalTransactionIndex
        >[0]);

      expect(parseNegativeIndex).to.throw(
        'Squads transaction index must be a non-negative JavaScript safe integer: -1',
      );
    });
  });

  describe(parseSquadMultisig.name, () => {
    it('throws when multisig container is not an object', () => {
      expect(() => parseSquadMultisig(null)).to.throw(
        'Squads multisig must be an object, got null',
      );
      expect(() => parseSquadMultisig([])).to.throw(
        'Squads multisig must be an object, got array',
      );
    });

    it('extracts numeric multisig fields', () => {
      const parsed = parseSquadMultisig({
        threshold: 3n,
        transactionIndex: 42n,
        staleTransactionIndex: 17n,
        timeLock: 60n,
      } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parsed).to.deep.equal({
        threshold: 3,
        currentTransactionIndex: 42,
        staleTransactionIndex: 17,
        timeLock: 60,
      });
    });

    it('throws contextual error when threshold getter throws', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          new Proxy(
            {
              transactionIndex: 1n,
              staleTransactionIndex: 0n,
              timeLock: 0n,
            },
            {
              get(target, property, receiver) {
                if (property === 'threshold') {
                  throw new Error('threshold unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ) as unknown as Parameters<typeof parseSquadMultisig>[0],
        );

      expect(parseInvalidMultisig).to.throw(
        'Failed to read Squads multisig threshold: threshold unavailable',
      );
    });

    it('throws contextual error when members getter throws', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          new Proxy(
            {
              threshold: 1n,
              transactionIndex: 1n,
              staleTransactionIndex: 0n,
              timeLock: 0n,
            },
            {
              get(target, property, receiver) {
                if (property === 'members') {
                  throw new Error('members unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ) as unknown as Parameters<typeof parseSquadMultisig>[0],
        );

      expect(parseInvalidMultisig).to.throw(
        'Failed to read Squads multisig members: members unavailable',
      );
    });

    it('throws contextual error when members length getter throws', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
          members: new Proxy([{ key: 'member-1' }], {
            get(target, property, receiver) {
              if (property === 'length') {
                throw new Error('members length unavailable');
              }
              return Reflect.get(target, property, receiver);
            },
          }),
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Failed to read Squads multisig members length: members length unavailable',
      );
    });

    it('throws contextual error when member index access throws', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
          members: new Proxy([{ key: 'member-1' }], {
            get(target, property, receiver) {
              if (property === '0') {
                throw new Error('member entry unavailable');
              }
              return Reflect.get(target, property, receiver);
            },
          }),
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Failed to read Squads multisig members[0]: member entry unavailable',
      );
    });

    it('accepts threshold of one with equal stale and current indices', () => {
      const parsed = parseSquadMultisig({
        threshold: 1n,
        transactionIndex: 7n,
        staleTransactionIndex: 7n,
        timeLock: 0n,
        members: [{ key: 'member-1' }],
      } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parsed).to.deep.equal({
        threshold: 1,
        currentTransactionIndex: 7,
        staleTransactionIndex: 7,
        timeLock: 0,
      });
    });

    it('accepts bignum-like values with decimal toString output', () => {
      const decimalLikeValue = { toString: () => '42' };
      const parsed = parseSquadMultisig({
        threshold: decimalLikeValue,
        transactionIndex: decimalLikeValue,
        staleTransactionIndex: decimalLikeValue,
        timeLock: decimalLikeValue,
      } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parsed).to.deep.equal({
        threshold: 42,
        currentTransactionIndex: 42,
        staleTransactionIndex: 42,
        timeLock: 42,
      });
    });

    it('accepts multisig values that stringify via Symbol.toPrimitive', () => {
      const decimalLikeValue = {
        [Symbol.toPrimitive]: () => '42',
      };
      const parsed = parseSquadMultisig({
        threshold: decimalLikeValue,
        transactionIndex: decimalLikeValue,
        staleTransactionIndex: decimalLikeValue,
        timeLock: decimalLikeValue,
      } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parsed).to.deep.equal({
        threshold: 42,
        currentTransactionIndex: 42,
        staleTransactionIndex: 42,
        timeLock: 42,
      });
    });

    it('accepts member keys that stringify via Symbol.toPrimitive', () => {
      const parsed = parseSquadMultisig({
        threshold: 1n,
        transactionIndex: 1n,
        staleTransactionIndex: 1n,
        timeLock: 0n,
        members: [
          {
            key: {
              [Symbol.toPrimitive]: () => 'member-key',
            },
          },
        ],
      } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parsed).to.deep.equal({
        threshold: 1,
        currentTransactionIndex: 1,
        staleTransactionIndex: 1,
        timeLock: 0,
      });
    });

    it('throws when multisig threshold is not a safe integer', () => {
      const parseUnsafeMultisig = () =>
        parseSquadMultisig({
          threshold: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseUnsafeMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer',
      );
    });

    it('throws when multisig threshold is non-numeric', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 'not-a-number',
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer: not-a-number',
      );
    });

    it('throws when multisig threshold is numeric string input', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: '42',
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer: 42',
      );
    });

    it('throws when multisig threshold is negative', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: -1,
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a positive JavaScript safe integer: -1',
      );
    });

    it('throws when multisig threshold is zero', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 0,
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a positive JavaScript safe integer: 0',
      );
    });

    it('throws when multisig threshold bignum-like value is zero', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: { toString: () => '0' },
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a positive JavaScript safe integer: 0',
      );
    });

    it('throws when multisig transaction index is negative', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1,
          transactionIndex: -1,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig transaction index must be a non-negative JavaScript safe integer: -1',
      );
    });

    it('throws when multisig stale transaction index is negative', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1,
          transactionIndex: 1,
          staleTransactionIndex: -1,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig stale transaction index must be a non-negative JavaScript safe integer: -1',
      );
    });

    it('throws when multisig timelock is negative', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1,
          transactionIndex: 1,
          staleTransactionIndex: 0,
          timeLock: -1,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig timelock must be a non-negative JavaScript safe integer: -1',
      );
    });

    it('throws when bignum-like value string is non-decimal', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: { toString: () => '1e3' },
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer: 1e3',
      );
    });

    it('throws safe-integer error when bignum-like toString throws', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: {
            toString: () => {
              throw new Error('boom');
            },
          },
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer: [unstringifiable value]',
      );
    });

    it('throws safe-integer error when toString output cannot stringify', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: {
            toString: () => ({
              [Symbol.toPrimitive]: () => {
                throw new Error('cannot stringify');
              },
            }),
          },
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer: [unstringifiable value]',
      );
    });

    it('throws safe-integer error when toString getter access throws', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: Object.create(null, {
            [Symbol.toPrimitive]: {
              value: () => {
                throw new Error('cannot stringify');
              },
            },
            toString: {
              get() {
                throw new Error('toString unavailable');
              },
            },
          }),
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer: [unstringifiable value]',
      );
    });

    it('throws safe-integer error when object-tag formatting also throws', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: Object.create(null, {
            [Symbol.toPrimitive]: {
              value: () => {
                throw new Error('cannot stringify');
              },
            },
            toString: {
              value: undefined,
            },
            [Symbol.toStringTag]: {
              get() {
                throw new Error('toStringTag unavailable');
              },
            },
          }),
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be a JavaScript safe integer: [unstringifiable value]',
      );
    });

    it('throws when multisig transaction index is not a safe integer', () => {
      const parseUnsafeMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          staleTransactionIndex: 0n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseUnsafeMultisig).to.throw(
        'Squads multisig transaction index must be a JavaScript safe integer',
      );
    });

    it('throws when multisig stale transaction index is not a safe integer', () => {
      const parseUnsafeMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseUnsafeMultisig).to.throw(
        'Squads multisig stale transaction index must be a JavaScript safe integer',
      );
    });

    it('throws when multisig timelock is not a safe integer', () => {
      const parseUnsafeMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 0n,
          timeLock: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseUnsafeMultisig).to.throw(
        'Squads multisig timelock must be a JavaScript safe integer',
      );
    });

    it('throws when stale transaction index exceeds transaction index', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 2n,
          timeLock: 0n,
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig stale transaction index must be less than or equal to transaction index: 2 > 1',
      );
    });

    it('throws when members field is present but not an array', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: 'not-an-array',
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members must be an array when provided',
      );
    });

    it('uses caller-provided field prefix for members-array shape errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 1n,
            timeLock: 0n,
            members: 'not-an-array',
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig members must be an array when provided',
      );
    });

    it('throws when members entry is not an object', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [1],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] must be an object',
      );
    });

    it('uses caller-provided field prefix for members entry object-shape errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 1n,
            timeLock: 0n,
            members: [1],
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig members[0] must be an object',
      );
    });

    it('throws when members entry is missing key', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{}],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] must include key',
      );
    });

    it('throws when members entry key is null', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: null }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] must include key',
      );
    });

    it('uses caller-provided field prefix for member key null errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 1n,
            timeLock: 0n,
            members: [{ key: null }],
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig members[0] must include key',
      );
    });

    it('throws when members entry key is an empty string', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: '   ' }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] key must be a non-empty string',
      );
    });

    it('throws when members entry key is non-stringifiable primitive', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: 7 }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] key must be an object or non-empty string',
      );
    });

    it('throws when object member key cannot be stringified', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [
            {
              key: {
                [Symbol.toPrimitive]: () => {
                  throw new Error('cannot stringify');
                },
              },
            },
          ],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] key must be stringifiable',
      );
    });

    it('throws when object member key stringifies to empty value', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: { toString: () => '   ' } }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] key must resolve to a non-empty string',
      );
    });

    it('throws when object member key stringifies to generic object label', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: {} }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] key must stringify to a meaningful identifier',
      );
    });

    it('throws when object member key stringifies to custom object label', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: { toString: () => '[object CustomKey]' } }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] key must stringify to a meaningful identifier',
      );
    });

    it('throws when object member key stringifies to padded generic object label', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: { toString: () => '  [object Object]  ' } }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig members[0] key must stringify to a meaningful identifier',
      );
    });

    it('uses caller-provided field prefix for empty normalized object keys', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 1n,
            timeLock: 0n,
            members: [{ key: { toString: () => '   ' } }],
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig members[0] key must resolve to a non-empty string',
      );
    });

    it('uses caller-provided field prefix for generic object key stringification errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 1n,
            timeLock: 0n,
            members: [{ key: {} }],
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig members[0] key must stringify to a meaningful identifier',
      );
    });

    it('throws when members array is empty but threshold is positive', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 1n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be less than or equal to member count: 1 > 0',
      );
    });

    it('skips member-count validation when members field is absent', () => {
      const parsed = parseSquadMultisig({
        threshold: 3n,
        transactionIndex: 4n,
        staleTransactionIndex: 4n,
        timeLock: 0n,
      } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parsed).to.deep.equal({
        threshold: 3,
        currentTransactionIndex: 4,
        staleTransactionIndex: 4,
        timeLock: 0,
      });
    });

    it('throws when threshold exceeds multisig member count', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig({
          threshold: 3n,
          transactionIndex: 1n,
          staleTransactionIndex: 1n,
          timeLock: 0n,
          members: [{ key: 'member-1' }, { key: 'member-2' }],
        } as unknown as Parameters<typeof parseSquadMultisig>[0]);

      expect(parseInvalidMultisig).to.throw(
        'Squads multisig threshold must be less than or equal to member count: 3 > 2',
      );
    });

    it('uses caller-provided field prefix for stale index invariant errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 2n,
            timeLock: 0n,
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig stale transaction index must be less than or equal to transaction index: 2 > 1',
      );
    });

    it('uses caller-provided field prefix for threshold/member-count invariant errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 3n,
            transactionIndex: 1n,
            staleTransactionIndex: 1n,
            timeLock: 0n,
            members: [{ key: 'member-1' }, { key: 'member-2' }],
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig threshold must be less than or equal to member count: 3 > 2',
      );
    });

    it('uses caller-provided field prefix for positive threshold errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 0n,
            transactionIndex: 1n,
            staleTransactionIndex: 0n,
            timeLock: 0n,
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig threshold must be a positive JavaScript safe integer: 0',
      );
    });

    it('uses caller-provided field prefix for member key errors', () => {
      const parseInvalidMultisig = () =>
        parseSquadMultisig(
          {
            threshold: 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 1n,
            timeLock: 0n,
            members: [{ key: null }],
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseInvalidMultisig).to.throw(
        'Squads solanamainnet multisig members[0] must include key',
      );
    });

    it('uses caller-provided field prefix in overflow errors', () => {
      const parseUnsafeMultisig = () =>
        parseSquadMultisig(
          {
            threshold: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
            transactionIndex: 1n,
            staleTransactionIndex: 0n,
            timeLock: 0n,
          } as unknown as Parameters<typeof parseSquadMultisig>[0],
          'solanamainnet multisig',
        );

      expect(parseUnsafeMultisig).to.throw(
        'Squads solanamainnet multisig threshold must be a JavaScript safe integer',
      );
    });
  });

  describe(decodePermissions.name, () => {
    it('decodes full permission mask', () => {
      expect(decodePermissions(SquadsPermission.ALL_PERMISSIONS)).to.equal(
        'Proposer, Voter, Executor',
      );
    });

    it('returns none for empty mask', () => {
      expect(decodePermissions(0)).to.equal('None');
    });

    it('throws for malformed permission masks', () => {
      expect(() => decodePermissions('7')).to.throw(
        'Expected permission mask to be a number, got string',
      );
      expect(() => decodePermissions(null)).to.throw(
        'Expected permission mask to be a number, got null',
      );
      expect(() => decodePermissions(-1)).to.throw(
        'Expected permission mask to be a non-negative safe integer, got -1',
      );
      expect(() => decodePermissions(1.5)).to.throw(
        'Expected permission mask to be a non-negative safe integer, got 1.5',
      );
      expect(() => decodePermissions(Number.NaN)).to.throw(
        'Expected permission mask to be a non-negative safe integer, got NaN',
      );
      expect(() => decodePermissions(Number.POSITIVE_INFINITY)).to.throw(
        'Expected permission mask to be a non-negative safe integer, got Infinity',
      );
      expect(() => decodePermissions(Number.MAX_SAFE_INTEGER + 1)).to.throw(
        `Expected permission mask to be a non-negative safe integer, got ${Number.MAX_SAFE_INTEGER + 1}`,
      );
    });
  });

  describe(parseSquadsProposalVoteError.name, () => {
    it('parses known vote error from string log payloads', () => {
      expect(
        parseSquadsProposalVoteError('custom program error: 0x177b'),
      ).to.equal(SquadsProposalVoteError.AlreadyRejected);
    });

    it('parses AlreadyRejected from named error', () => {
      expect(
        parseSquadsProposalVoteError(['Program log: AlreadyRejected']),
      ).to.equal(SquadsProposalVoteError.AlreadyRejected);
    });

    it('parses AlreadyApproved from hex error code', () => {
      expect(
        parseSquadsProposalVoteError(['custom program error: 0x177a']),
      ).to.equal(SquadsProposalVoteError.AlreadyApproved);
    });

    it('parses AlreadyCancelled from hex error code', () => {
      expect(
        parseSquadsProposalVoteError(['custom program error: 0x177c']),
      ).to.equal(SquadsProposalVoteError.AlreadyCancelled);
    });

    it('returns undefined for unrelated logs', () => {
      expect(parseSquadsProposalVoteError(['some unrelated log'])).to.equal(
        undefined,
      );
    });

    it('parses case-insensitive named and hex errors', () => {
      expect(
        parseSquadsProposalVoteError(['Program log: ALREADYCANCELLED']),
      ).to.equal(SquadsProposalVoteError.AlreadyCancelled);
      expect(
        parseSquadsProposalVoteError(['custom program error: 0x177B']),
      ).to.equal(SquadsProposalVoteError.AlreadyRejected);
      expect(
        parseSquadsProposalVoteError(['custom program error: 0x177C']),
      ).to.equal(SquadsProposalVoteError.AlreadyCancelled);
    });

    it('prioritizes rejection errors when multiple known errors are present', () => {
      expect(
        parseSquadsProposalVoteError([
          'custom program error: 0x177a',
          'custom program error: 0x177b',
          'custom program error: 0x177c',
        ]),
      ).to.equal(SquadsProposalVoteError.AlreadyRejected);
    });

    it('parses readonly frozen transaction logs', () => {
      const frozenLogs = Object.freeze([
        'Program log: AlreadyApproved',
      ]) as readonly string[];

      expect(parseSquadsProposalVoteError(frozenLogs)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('returns undefined for malformed vote-log payloads', () => {
      expect(parseSquadsProposalVoteError(null)).to.equal(undefined);
      expect(parseSquadsProposalVoteError(1)).to.equal(undefined);
      expect(parseSquadsProposalVoteError(false)).to.equal(undefined);
      expect(parseSquadsProposalVoteError(Symbol('vote-log'))).to.equal(
        undefined,
      );
      expect(parseSquadsProposalVoteError([1, 2, 3])).to.equal(undefined);
      expect(parseSquadsProposalVoteError([{ log: '0x177b' }])).to.equal(
        undefined,
      );
    });

    it('returns undefined for vote-log arrays that throw during filtering', () => {
      const throwingLogArray = new Proxy(['custom program error: 0x177b'], {
        get(target, property, receiver) {
          if (property === '0') {
            throw new Error('log entry unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() =>
        parseSquadsProposalVoteError(throwingLogArray),
      ).to.not.throw();
      expect(parseSquadsProposalVoteError(throwingLogArray)).to.equal(
        undefined,
      );
    });

    it('parses known errors from vote-log arrays when other entries throw', () => {
      const partiallyReadableLogs = new Proxy(
        ['Program log: AlreadyCancelled', 'custom program error: 0x177a'],
        {
          get(target, property, receiver) {
            if (property === '0') {
              throw new Error('first log unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(parseSquadsProposalVoteError(partiallyReadableLogs)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('returns undefined for vote-log arrays with malformed length values', () => {
      const malformedLengthLogs = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') {
            return 1n;
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() =>
        parseSquadsProposalVoteError(malformedLengthLogs),
      ).to.not.throw();
      expect(parseSquadsProposalVoteError(malformedLengthLogs)).to.equal(
        undefined,
      );
    });
  });

  describe(parseSquadsProposalVoteErrorFromError.name, () => {
    it('parses known vote error from string error values', () => {
      expect(
        parseSquadsProposalVoteErrorFromError('custom program error: 0x177b'),
      ).to.equal(SquadsProposalVoteError.AlreadyRejected);
    });

    it('parses known vote error from direct log array values', () => {
      expect(
        parseSquadsProposalVoteErrorFromError([
          123,
          'Program log: AlreadyCancelled',
        ]),
      ).to.equal(SquadsProposalVoteError.AlreadyCancelled);
    });

    it('returns undefined for direct log arrays without known errors', () => {
      expect(
        parseSquadsProposalVoteErrorFromError(['Program log: unrelated', 999]),
      ).to.equal(undefined);
    });

    it('prioritizes rejection errors in direct log arrays with multiple matches', () => {
      expect(
        parseSquadsProposalVoteErrorFromError([
          'custom program error: 0x177a',
          'custom program error: 0x177b',
          'custom program error: 0x177c',
        ]),
      ).to.equal(SquadsProposalVoteError.AlreadyRejected);
    });

    it('parses known vote error from direct arrays of wrapped objects', () => {
      expect(
        parseSquadsProposalVoteErrorFromError([
          { note: 'unrelated' },
          { response: { data: { logs: ['custom program error: 0x177c'] } } },
        ]),
      ).to.equal(SquadsProposalVoteError.AlreadyCancelled);
    });

    it('ignores arbitrary string arrays under unknown keys', () => {
      expect(
        parseSquadsProposalVoteErrorFromError({
          metadata: {
            notes: ['custom program error: 0x177a'],
          },
        }),
      ).to.equal(undefined);
    });

    it('parses known vote error from unknown error shape', () => {
      const error = {
        transactionLogs: ['Program log: AlreadyCancelled'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('parses known vote error from fallback logs field', () => {
      const error = {
        logs: ['Program log: AlreadyRejected'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('falls back to logs when transactionLogs has no known errors', () => {
      const error = {
        transactionLogs: ['Program log: unrelated'],
        logs: ['custom program error: 0x177a'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from string log fields', () => {
      const error = {
        transactionLogs: 'Program log: AlreadyRejected',
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('prefers transactionLogs over logs when both contain known errors', () => {
      const error = {
        transactionLogs: ['custom program error: 0x177c'],
        logs: ['custom program error: 0x177b'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('prefers string transactionLogs over logs when both contain known errors', () => {
      const error = {
        transactionLogs: 'custom program error: 0x177a',
        logs: ['custom program error: 0x177b'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('uses logs when transactionLogs is present but not string/array', () => {
      const error = {
        transactionLogs: 123,
        logs: ['custom program error: 0x177a'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('uses logs fallback when transactionLogs array throws during parsing', () => {
      const error = {
        transactionLogs: new Proxy(['custom program error: 0x177b'], {
          get(target, property, receiver) {
            if (property === '0') {
              throw new Error('log entry unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        }),
        logs: ['custom program error: 0x177a'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses transactionLogs when at least one log entry remains readable', () => {
      const error = {
        transactionLogs: new Proxy(
          ['Program log: AlreadyCancelled', 'custom program error: 0x177a'],
          {
            get(target, property, receiver) {
              if (property === '0') {
                throw new Error('first log unavailable');
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
        logs: ['custom program error: 0x177b'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('uses logs fallback when transactionLogs length is malformed', () => {
      const error = {
        transactionLogs: new Proxy([], {
          get(target, property, receiver) {
            if (property === 'length') {
              return 1n;
            }
            return Reflect.get(target, property, receiver);
          },
        }),
        logs: ['custom program error: 0x177a'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from nested data logs', () => {
      const error = {
        data: {
          logs: ['Program log: AlreadyApproved'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from logMessages fields', () => {
      const error = {
        data: {
          logMessages: ['custom program error: 0x177b'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('parses known vote error from transactionLogMessages fields', () => {
      const error = {
        response: {
          data: {
            transactionLogMessages: ['Program log: AlreadyApproved'],
          },
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from nested cause transaction logs', () => {
      const error = {
        cause: {
          transactionLogs: ['custom program error: 0x177b'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('parses known vote error from nested error field', () => {
      const error = {
        error: {
          logs: ['custom program error: 0x177a'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from nested originalError field', () => {
      const error = {
        originalError: {
          transactionLogs: ['custom program error: 0x177b'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('parses known vote error from nested response.data logs', () => {
      const error = {
        response: {
          data: {
            logs: ['custom program error: 0x177a'],
          },
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from unknown log-like array keys', () => {
      const error = {
        payload: {
          programLogs: ['custom program error: 0x177c'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('parses known vote error from singular log string keys', () => {
      const error = {
        payload: {
          log: 'Program log: AlreadyApproved',
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from snake_case log-like array keys', () => {
      const error = {
        payload: {
          program_logs: ['custom program error: 0x177a'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from string-valued log-like keys', () => {
      const error = {
        payload: {
          programLogs: 'custom program error: 0x177b',
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('parses known vote error from arbitrary nested wrapper keys', () => {
      const error = {
        metadata: {
          wrapped: {
            deeplyNested: {
              logs: ['custom program error: 0x177b'],
            },
          },
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('ignores arbitrary non-error string fields', () => {
      const error = {
        metadata: {
          note: 'diagnostic 0x177a identifier',
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(undefined);
    });

    it('ignores non-log array keys that only contain log as substring', () => {
      const error = {
        metadata: {
          catalog: ['custom program error: 0x177b'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(undefined);
    });

    it('ignores non-log string keys that only contain log as substring', () => {
      const error = {
        metadata: {
          logical: 'custom program error: 0x177c',
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(undefined);
    });

    it('parses known vote error from string originalError field', () => {
      const error = {
        originalError: 'Program log: AlreadyCancelled',
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('parses known vote error from shortMessage field', () => {
      const error = {
        shortMessage: 'custom program error: 0x177a',
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from details field', () => {
      const error = {
        details: 'Program log: AlreadyRejected',
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('parses known vote error from message field', () => {
      const error = {
        message: 'Squads transaction failed: custom program error: 0x177c',
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('parses known vote error from nested cause message', () => {
      const error = {
        cause: {
          message: 'Program log: AlreadyRejected',
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('parses known vote error from string cause values', () => {
      const error = {
        cause: 'custom program error: 0x177a',
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('tolerates throwing message accessors while parsing fallback log fields', () => {
      const error = {
        logs: ['custom program error: 0x177a'],
      } as {
        logs: readonly string[];
        message?: string;
      };
      Object.defineProperty(error, 'message', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('message unavailable');
        },
      });

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('tolerates throwing known-log-field accessors while parsing other fields', () => {
      const error = {
        details: 'Program log: AlreadyCancelled',
      } as {
        details: string;
        transactionLogs?: unknown;
      };
      Object.defineProperty(error, 'transactionLogs', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('logs unavailable');
        },
      });

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('tolerates throwing log-like accessors while parsing nested wrappers', () => {
      const error = {
        cause: {
          logs: ['custom program error: 0x177b'],
        },
      } as {
        cause: { logs: readonly string[] };
        programLogs?: unknown;
      };
      Object.defineProperty(error, 'programLogs', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('program logs unavailable');
        },
      });

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('tolerates ownKeys traps when known log fields are present', () => {
      const error = new Proxy(
        {
          logs: ['custom program error: 0x177a'],
        },
        {
          ownKeys() {
            throw new Error('ownKeys unavailable');
          },
        },
      );

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('returns undefined when ownKeys traps and no known fields resolve', () => {
      const error = new Proxy(
        { metadata: { logs: ['custom program error: 0x177b'] } },
        {
          ownKeys() {
            throw new Error('ownKeys unavailable');
          },
        },
      );

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(undefined);
    });

    it('prefers top-level parsed errors over nested errors', () => {
      const error = {
        logs: ['custom program error: 0x177c'],
        cause: {
          transactionLogs: ['custom program error: 0x177b'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('parses known vote error from nested value logs', () => {
      const error = {
        value: {
          logs: ['custom program error: 0x177b'],
        },
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('handles cyclic unknown error objects safely', () => {
      const error = {
        transactionLogs: ['Program log: unrelated'],
      } as {
        transactionLogs: readonly string[];
        cause?: unknown;
      };
      error.cause = error;

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(undefined);
    });

    it('parses known vote errors from cyclic object graphs', () => {
      const root = {
        transactionLogs: ['Program log: unrelated'],
      } as {
        transactionLogs: readonly string[];
        nested?: unknown;
      };
      const nested = {
        logs: ['custom program error: 0x177b'],
        parent: root,
      };
      root.nested = nested;

      expect(parseSquadsProposalVoteErrorFromError(root)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('parses known vote errors from cyclic array wrappers', () => {
      const cyclicArray: unknown[] = [];
      cyclicArray.push({ logs: ['custom program error: 0x177a'] });
      cyclicArray.push(cyclicArray);

      expect(parseSquadsProposalVoteErrorFromError(cyclicArray)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('parses known vote error from aggregate errors array', () => {
      const error = {
        errors: [{ message: 'unrelated' }, 'custom program error: 0x177a'],
      };

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyApproved,
      );
    });

    it('ignores non-array aggregate errors values while parsing', () => {
      const error = {
        error: { logs: ['custom program error: 0x177b'] },
        errors: { logs: ['custom program error: 0x177a'] },
        logs: ['custom program error: 0x177c'],
      };

      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('parses known vote error from frozen log arrays in unknown error shape', () => {
      const error = {
        transactionLogs: Object.freeze(['Program log: AlreadyRejected']),
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyRejected,
      );
    });

    it('returns undefined for malformed unknown error shape', () => {
      expect(parseSquadsProposalVoteErrorFromError({})).to.equal(undefined);
      expect(parseSquadsProposalVoteErrorFromError(null)).to.equal(undefined);
      expect(
        parseSquadsProposalVoteErrorFromError({
          transactionLogs: ['ok', 123],
        }),
      ).to.equal(undefined);
    });

    it('ignores non-string logs but still parses known errors', () => {
      expect(
        parseSquadsProposalVoteErrorFromError({
          transactionLogs: [123, 'custom program error: 0x177b'],
        }),
      ).to.equal(SquadsProposalVoteError.AlreadyRejected);
    });

    it('ignores non-string logs in frozen arrays while still parsing known errors', () => {
      expect(
        parseSquadsProposalVoteErrorFromError({
          transactionLogs: Object.freeze([123, 'custom program error: 0x177a']),
        }),
      ).to.equal(SquadsProposalVoteError.AlreadyApproved);
    });
  });

  describe(getSquadAndProvider.name, () => {
    it('returns provider and squads keys for supported chains', async () => {
      const supportedChain = 'solanamainnet';
      const provider = {
        getAccountInfo: async () => null,
      };
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return provider;
        },
      };

      const { chain, svmProvider, vault, multisigPda, programId } =
        getSquadAndProvider(supportedChain, mpp);

      expect(chain).to.equal(supportedChain);
      expect(providerLookupChain).to.equal(supportedChain);
      expect(svmProvider).to.equal(provider);
      expect(vault).to.be.instanceOf(PublicKey);
      expect(multisigPda).to.be.instanceOf(PublicKey);
      expect(programId).to.be.instanceOf(PublicKey);
      expect(vault.toBase58()).to.equal(squadsConfigs[supportedChain].vault);
      expect(multisigPda.toBase58()).to.equal(
        squadsConfigs[supportedChain].multisigPda,
      );
      expect(programId.toBase58()).to.equal(
        squadsConfigs[supportedChain].programId,
      );
    });

    it('normalizes padded chain names before provider lookup', () => {
      const provider = {
        getAccountInfo: async () => null,
      };
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return provider;
        },
      };

      const { chain, vault, multisigPda, programId, svmProvider } =
        getSquadAndProvider('  solanamainnet  ', mpp);

      expect(chain).to.equal('solanamainnet');
      expect(providerLookupChain).to.equal('solanamainnet');
      expect(svmProvider).to.equal(provider);
      expect(vault.toBase58()).to.equal(squadsConfigs.solanamainnet.vault);
      expect(multisigPda.toBase58()).to.equal(
        squadsConfigs.solanamainnet.multisigPda,
      );
      expect(programId.toBase58()).to.equal(
        squadsConfigs.solanamainnet.programId,
      );
    });

    it('resolves provider when multiprovider resolver relies on this binding', () => {
      const provider = {
        getAccountInfo: async () => null,
      };
      const mpp = {
        providers: {
          solanamainnet: provider,
        },
        getSolanaWeb3Provider(
          this: {
            providers: Record<string, unknown>;
          },
          chain: string,
        ) {
          return this.providers[chain];
        },
      };

      const { svmProvider } = getSquadAndProvider('solanamainnet', mpp);

      expect(svmProvider).to.equal(provider);
    });

    it('fails fast for unsupported chains before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('unsupported-chain', mpp),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for padded unsupported chains before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('  unsupported-chain  ', mpp),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before provider lookup', () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      };

      const thrownError = captureSyncError(() => getSquadAndProvider(1, mpp));

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before provider lookup', () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('   ', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for primitive multiprovider values', () => {
      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', 1),
      );

      expect(thrownError?.message).to.equal(
        'Invalid multiprovider for solanamainnet: expected getSolanaWeb3Provider function, got undefined',
      );
    });

    it('fails fast when multiprovider does not expose getSolanaWeb3Provider', () => {
      const mpp = {};

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Invalid multiprovider for solanamainnet: expected getSolanaWeb3Provider function, got undefined',
      );
    });

    it('throws contextual error when multiprovider getSolanaWeb3Provider accessor fails', () => {
      const mpp = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'getSolanaWeb3Provider') {
              throw new Error('resolver unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read getSolanaWeb3Provider for solanamainnet: resolver unavailable',
      );
    });

    it('uses deterministic placeholder when multiprovider resolver accessor throws opaque value', () => {
      const mpp = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'getSolanaWeb3Provider') {
              throw {};
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read getSolanaWeb3Provider for solanamainnet: [unstringifiable error]',
      );
    });

    it('propagates provider lookup failures for supported chains', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup failed');
        },
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.include('provider lookup failed');
      expect(providerLookupCalled).to.equal(true);
    });

    it('throws stable error when provider lookup returns promise-like value', () => {
      const mpp = {
        getSolanaWeb3Provider: () =>
          Promise.resolve({
            getAccountInfo: async () => null,
          }),
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Invalid solana provider for solanamainnet: expected synchronous provider, got promise-like value',
      );
    });

    it('throws stable error when provider promise-like inspection fails', () => {
      const mpp = {
        getSolanaWeb3Provider: () =>
          new Proxy(
            {},
            {
              get(target, property, receiver) {
                if (property === 'then') {
                  throw new Error('then unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ),
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Failed to inspect solana provider for solanamainnet: failed to read promise-like then field (then unavailable)',
      );
    });

    it('throws contextual error when provider getAccountInfo accessor fails', () => {
      const mpp = {
        getSolanaWeb3Provider: () =>
          new Proxy(
            {},
            {
              get(target, property, receiver) {
                if (property === 'getAccountInfo') {
                  throw new Error('account info unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ),
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read getAccountInfo for solanamainnet: account info unavailable',
      );
    });

    it('uses provided provider override without multiprovider lookup', () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      };
      const providerOverride = {
        getAccountInfo: async () => null,
      };

      const { chain, svmProvider } = getSquadAndProvider(
        '  solanamainnet  ',
        mpp,
        providerOverride,
      );

      expect(providerLookupCalled).to.equal(false);
      expect(chain).to.equal('solanamainnet');
      expect(svmProvider).to.equal(providerOverride);
    });

    it('rejects malformed provider overrides before multiprovider lookup', () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp, {}),
      );

      expect(thrownError?.message).to.equal(
        'Invalid solana provider for solanamainnet: expected getAccountInfo function, got undefined',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('rejects promise-like provider overrides before multiprovider lookup', () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      };

      const thrownError = captureSyncError(() =>
        getSquadAndProvider(
          'solanamainnet',
          mpp,
          Promise.resolve({
            getAccountInfo: async () => null,
          }),
        ),
      );

      expect(thrownError?.message).to.equal(
        'Invalid solana provider for solanamainnet: expected synchronous provider, got promise-like value',
      );
      expect(providerLookupCalled).to.equal(false);
    });
  });

  describe(getPendingProposalsForChains.name, () => {
    it('fails fast for malformed chain entry values before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getPendingProposalsForChains(['solanamainnet', 1], mpp),
      );

      expect(thrownError?.message).to.equal(
        'Expected partitioned squads chains[1] to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain container values before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getPendingProposalsForChains('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.equal(
        'Expected partitioned squads chains to be an array, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('skips malformed primitive multiprovider values per-chain', async () => {
      const proposals = await getPendingProposalsForChains(
        ['solanamainnet'],
        1,
      );

      expect(proposals).to.deep.equal([]);
    });

    it('normalizes and deduplicates chain inputs before provider lookups', async () => {
      const providerLookupChains: string[] = [];
      const mpp = {
        getChainMetadata: () => ({
          nativeToken: {
            decimals: 9,
            symbol: 'SOL',
          },
        }),
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChains.push(chain);
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposals = await getPendingProposalsForChains(
        [' solanamainnet ', 'solanamainnet', 'unsupported', ' unsupported '],
        mpp,
      );

      expect(proposals).to.deep.equal([]);
      expect(providerLookupChains).to.deep.equal(['solanamainnet']);
    });

    it('skips provider lookups when all input chains are unsupported', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const proposals = await getPendingProposalsForChains(
        ['unsupported', ' unsupported '],
        mpp,
      );

      expect(proposals).to.deep.equal([]);
      expect(providerLookupCalled).to.equal(false);
    });

    it('does not mutate caller-provided chain arrays while scanning proposals', async () => {
      const chains = [' solanamainnet ', 'unsupported', ' solanamainnet '];
      const baselineChains = [...chains];
      const mpp = {
        getChainMetadata: () => ({
          nativeToken: {
            decimals: 9,
            symbol: 'SOL',
          },
        }),
        getSolanaWeb3Provider: () => {
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposals = await getPendingProposalsForChains(chains, mpp);

      expect(proposals).to.deep.equal([]);
      expect(chains).to.deep.equal(baselineChains);
    });

    it('accepts readonly frozen chain arrays while scanning proposals', async () => {
      const providerLookupChains: string[] = [];
      const chains = Object.freeze([
        ' solanamainnet ',
        ' solanamainnet ',
      ]) as readonly string[];
      const mpp = {
        getChainMetadata: () => ({
          nativeToken: {
            decimals: 9,
            symbol: 'SOL',
          },
        }),
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChains.push(chain);
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposals = await getPendingProposalsForChains(chains, mpp);

      expect(proposals).to.deep.equal([]);
      expect(providerLookupChains).to.deep.equal(['solanamainnet']);
    });

    it('skips provider lookup when multi-provider metadata accessor is missing', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const proposals = await getPendingProposalsForChains(
        ['solanamainnet'],
        mpp,
      );

      expect(proposals).to.deep.equal([]);
      expect(providerLookupCalled).to.equal(false);
    });

    it('skips provider lookup when chain metadata decimals are malformed', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getChainMetadata: () => ({
          nativeToken: {
            decimals: -1,
            symbol: 'SOL',
          },
        }),
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const proposals = await getPendingProposalsForChains(
        ['solanamainnet'],
        mpp,
      );

      expect(proposals).to.deep.equal([]);
      expect(providerLookupCalled).to.equal(false);
    });

    it('skips chain when provider lacks getBalance function', async () => {
      const originalFromAccountAddress = accounts.Multisig.fromAccountAddress;
      try {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = async () =>
          ({
            threshold: 1,
            transactionIndex: 0,
            staleTransactionIndex: 0,
            timeLock: 0,
          }) as unknown as accounts.Multisig;

        let providerLookupChain: string | undefined;
        const mpp = {
          getChainMetadata: () => ({
            nativeToken: {
              decimals: 9,
              symbol: 'SOL',
            },
          }),
          getSolanaWeb3Provider: (chain: string) => {
            providerLookupChain = chain;
            return {
              getAccountInfo: async () => null,
            };
          },
        };

        const proposals = await getPendingProposalsForChains(
          ['solanamainnet'],
          mpp,
        );

        expect(proposals).to.deep.equal([]);
        expect(providerLookupChain).to.equal('solanamainnet');
      } finally {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = originalFromAccountAddress;
      }
    });

    it('skips chain when provider getBalance accessor fails', async () => {
      const originalFromAccountAddress = accounts.Multisig.fromAccountAddress;
      try {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = async () =>
          ({
            threshold: 1,
            transactionIndex: 0,
            staleTransactionIndex: 0,
            timeLock: 0,
          }) as unknown as accounts.Multisig;

        const mpp = {
          getChainMetadata: () => ({
            nativeToken: {
              decimals: 9,
              symbol: 'SOL',
            },
          }),
          getSolanaWeb3Provider: () =>
            new Proxy(
              {
                getAccountInfo: async () => null,
              },
              {
                get(target, property, receiver) {
                  if (property === 'getBalance') {
                    throw new Error('balance accessor unavailable');
                  }
                  return Reflect.get(target, property, receiver);
                },
              },
            ),
        };

        const proposals = await getPendingProposalsForChains(
          ['solanamainnet'],
          mpp,
        );

        expect(proposals).to.deep.equal([]);
      } finally {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = originalFromAccountAddress;
      }
    });

    it('skips chain when provider returns malformed vault balance', async () => {
      const originalFromAccountAddress = accounts.Multisig.fromAccountAddress;
      try {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = async () =>
          ({
            threshold: 1,
            transactionIndex: 0,
            staleTransactionIndex: 0,
            timeLock: 0,
          }) as unknown as accounts.Multisig;

        const mpp = {
          getChainMetadata: () => ({
            nativeToken: {
              decimals: 9,
              symbol: 'SOL',
            },
          }),
          getSolanaWeb3Provider: () => ({
            getAccountInfo: async () => null,
            getBalance: async () => 'malformed-balance',
          }),
        };

        const proposals = await getPendingProposalsForChains(
          ['solanamainnet'],
          mpp,
        );

        expect(proposals).to.deep.equal([]);
      } finally {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = originalFromAccountAddress;
      }
    });
  });

  describe(getSquadProposal.name, () => {
    it('normalizes padded chain names before proposal provider lookup', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('  solanamainnet  ', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('allows zero transaction index and still attempts provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('solanamainnet', mpp, 0);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('returns undefined when provider lookup throws for supported chains', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('looks up provider once when proposal fetch fails', async () => {
      let providerLookupCount = 0;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCount += 1;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCount).to.equal(1);
    });

    it('returns undefined when provider lookup throws malformed Error values', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw createErrorWithUnformattableMessage();
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('returns undefined when provider lookup throws generic-stringified Error values', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw createErrorWithGenericObjectStringification();
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('returns undefined when provider lookup throws objects with message fields', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw createUnstringifiableObjectErrorWithMessage(
            'provider lookup failed',
          );
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('returns undefined when provider bridge validation fails', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          return {};
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('uses provided provider override without multiprovider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposal(
        'solanamainnet',
        mpp,
        1,
        {} as ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>,
      );

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chains before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('unsupported-chain', mpp, 1),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chains before malformed transaction index type validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('unsupported-chain', mpp, '1'),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for padded unsupported chains before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('  unsupported-chain  ', mpp, 1),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal(1, mpp, 1),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('   ', mpp, 1),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for negative transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('solanamainnet', mpp, -1),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got -1',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for non-integer transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('solanamainnet', mpp, 1.5),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got 1.5',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsafe transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const unsafeIndex = Number.MAX_SAFE_INTEGER + 1;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('solanamainnet', mpp, unsafeIndex),
      );

      expect(thrownError?.message).to.equal(
        `Expected transaction index to be a non-negative safe integer for solanamainnet, got ${unsafeIndex}`,
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for NaN transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('solanamainnet', mpp, Number.NaN),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got NaN',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for infinite transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('solanamainnet', mpp, Number.POSITIVE_INFINITY),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got Infinity',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for string transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('solanamainnet', mpp, '1'),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for null transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposal('solanamainnet', mpp, null),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got null',
      );
      expect(providerLookupCalled).to.equal(false);
    });
  });

  describe(getSquadProposalAccount.name, () => {
    it('normalizes padded chain names before account provider lookup', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount(
        '  solanamainnet  ',
        mpp,
        1,
      );

      expect(proposal).to.equal(undefined);
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('allows zero transaction index and still attempts provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount('solanamainnet', mpp, 0);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('fails fast for unsupported chains before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount('unsupported-chain', mpp, 1),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chains before malformed transaction index type validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount('unsupported-chain', mpp, '1'),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for padded unsupported chains before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount('  unsupported-chain  ', mpp, 1),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before account fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount(1, mpp, 1),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before account fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount('   ', mpp, 1),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('returns undefined when provider lookup throws for supported chains', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('looks up provider once when proposal-account fetch fails', async () => {
      let providerLookupCount = 0;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCount += 1;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCount).to.equal(1);
    });

    it('returns undefined when provider lookup throws malformed Error values', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw createErrorWithUnformattableMessage();
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('returns undefined when provider lookup throws generic-stringified Error values', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw createErrorWithGenericObjectStringification();
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('returns undefined when provider lookup throws objects with message fields', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw createUnstringifiableObjectErrorWithMessage(
            'provider lookup failed',
          );
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('returns undefined when provider bridge validation fails', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          return {};
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount('solanamainnet', mpp, 1);

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(true);
    });

    it('uses provided provider override without multiprovider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const proposal = await getSquadProposalAccount(
        'solanamainnet',
        mpp,
        1,
        {} as Parameters<typeof getSquadProposalAccount>[3],
      );

      expect(proposal).to.equal(undefined);
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for invalid transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount('solanamainnet', mpp, Number.NaN),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got NaN',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for string transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount('solanamainnet', mpp, '1'),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for null transaction index before proposal fetch attempts', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getSquadProposalAccount('solanamainnet', mpp, null),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got null',
      );
      expect(providerLookupCalled).to.equal(false);
    });
  });

  describe(buildSquadsVaultTransactionProposal.name, () => {
    it('fails fast for unsupported chain names before proposal build provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'unsupported-chain',
          mpp,
          [],
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before proposal build provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal('   ', mpp, [], PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('normalizes padded chain names before proposal build provider lookup', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          '  solanamainnet  ',
          mpp,
          [],
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include('provider lookup failed');
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('fails fast for malformed chain names before proposal build provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(1, mpp, [], PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed proposal creators before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          [],
          'malformed-creator',
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal creator for solanamainnet to be a PublicKey, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed proposal instruction containers before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          'malformed-instructions',
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal instructions for solanamainnet to be an array, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed proposal instructions before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          [{}],
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal instructions for solanamainnet[0] to be a TransactionInstruction, got object',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('throws contextual errors when proposal instruction length access fails', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const hostileInstructions = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('length unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          hostileInstructions,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read proposal instructions for solanamainnet length: length unavailable',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('throws contextual errors when proposal instruction index access fails', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const instructionList = new Proxy(
        [
          new TransactionInstruction({
            keys: [],
            programId: PublicKey.default,
          }),
        ],
        {
          get(target, property, receiver) {
            if (property === '0') {
              throw new Error('instruction unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          instructionList,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read proposal instructions for solanamainnet[0]: instruction unavailable',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed proposal memo values before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          [],
          PublicKey.default,
          1,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal memo for solanamainnet to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('looks up provider once when proposal build fails during provider validation', async () => {
      let providerLookupCount = 0;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCount += 1;
          return {};
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          [],
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Invalid solana provider for solanamainnet: expected getAccountInfo function, got undefined',
      );
      expect(providerLookupCount).to.equal(1);
    });

    it('throws contextual error when multisig account prefetch fails during proposal build', async () => {
      let providerLookupCount = 0;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCount += 1;
          return {
            getAccountInfo: async () => {
              throw new Error('account unavailable');
            },
          };
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          [],
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Failed to fetch multisig account ',
      );
      expect(thrownError?.message).to.include(
        'on solanamainnet: account unavailable',
      );
      expect(providerLookupCount).to.equal(1);
    });

    it('uses placeholder when multisig account prefetch throws opaque value during proposal build', async () => {
      let providerLookupCount = 0;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCount += 1;
          return {
            getAccountInfo: async () => {
              throw {};
            },
          };
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          [],
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Failed to fetch multisig account ',
      );
      expect(thrownError?.message).to.include(
        'on solanamainnet: [unstringifiable error]',
      );
      expect(providerLookupCount).to.equal(1);
    });

    it('throws stable error when provider lacks getLatestBlockhash during proposal build', async () => {
      const originalFromAccountAddress = accounts.Multisig.fromAccountAddress;
      try {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = async () =>
          ({
            threshold: 1,
            transactionIndex: 0,
            staleTransactionIndex: 0,
            timeLock: 0,
          }) as unknown as accounts.Multisig;
        const mpp = {
          getSolanaWeb3Provider: () => ({
            getAccountInfo: async () => ({
              owner: getSquadsKeys('solanamainnet').programId,
            }),
          }),
        };

        const thrownError = await captureAsyncError(() =>
          buildSquadsVaultTransactionProposal(
            'solanamainnet',
            mpp,
            [],
            PublicKey.default,
          ),
        );

        expect(thrownError?.message).to.equal(
          'Invalid solana provider for solanamainnet: expected getLatestBlockhash function, got undefined',
        );
      } finally {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = originalFromAccountAddress;
      }
    });

    it('throws contextual error when getLatestBlockhash accessor fails during proposal build', async () => {
      const originalFromAccountAddress = accounts.Multisig.fromAccountAddress;
      try {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = async () =>
          ({
            threshold: 1,
            transactionIndex: 0,
            staleTransactionIndex: 0,
            timeLock: 0,
          }) as unknown as accounts.Multisig;
        const mpp = {
          getSolanaWeb3Provider: () =>
            new Proxy(
              {
                getAccountInfo: async () => ({
                  owner: getSquadsKeys('solanamainnet').programId,
                }),
              },
              {
                get(target, property, receiver) {
                  if (property === 'getLatestBlockhash') {
                    throw new Error('blockhash unavailable');
                  }
                  return Reflect.get(target, property, receiver);
                },
              },
            ),
        };

        const thrownError = await captureAsyncError(() =>
          buildSquadsVaultTransactionProposal(
            'solanamainnet',
            mpp,
            [],
            PublicKey.default,
          ),
        );

        expect(thrownError?.message).to.equal(
          'Failed to read getLatestBlockhash for solanamainnet: blockhash unavailable',
        );
      } finally {
        (
          accounts.Multisig as unknown as {
            fromAccountAddress: typeof originalFromAccountAddress;
          }
        ).fromAccountAddress = originalFromAccountAddress;
      }
    });

    it('uses provided provider override without multiprovider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsVaultTransactionProposal(
          'solanamainnet',
          mpp,
          [],
          PublicKey.default,
          undefined,
          {},
        ),
      );

      expect(thrownError?.message).to.equal(
        'Invalid solana provider for solanamainnet: expected getAccountInfo function, got undefined',
      );
      expect(providerLookupCalled).to.equal(false);
    });
  });

  describe(buildSquadsProposalRejection.name, () => {
    it('fails fast for unsupported chain names before rejection provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(
          'unsupported-chain',
          mpp,
          1n,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chain names before rejection index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(
          'unsupported-chain',
          mpp,
          -1n,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chain names before malformed rejection index type validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(
          'unsupported-chain',
          mpp,
          1,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('normalizes padded chain names before rejection provider lookup', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {
            getAccountInfo: async () => null,
          };
        },
      } as unknown as MultiProtocolProvider;

      const result = await buildSquadsProposalRejection(
        '  solanamainnet  ',
        mpp,
        1n,
        PublicKey.default,
      );

      expect(providerLookupChain).to.equal('solanamainnet');
      expect(result.instruction).to.not.equal(undefined);
    });

    it('fails fast for malformed chain names before rejection provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(1, mpp, 1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before rejection provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection('   ', mpp, 1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before rejection index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection('   ', mpp, -1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for non-bigint transaction index before rejection provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(
          'solanamainnet',
          mpp,
          1,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a bigint for solanamainnet, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for null transaction index before rejection provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(
          'solanamainnet',
          mpp,
          null,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a bigint for solanamainnet, got null',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before transaction index validation in rejection helper', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(1, mpp, -1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for negative transaction index before rejection provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(
          'solanamainnet',
          mpp,
          -1n,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative bigint for solanamainnet, got -1',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed rejection members before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalRejection(
          'solanamainnet',
          mpp,
          1n,
          'malformed-member',
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal rejection member for solanamainnet to be a PublicKey, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });
  });

  describe(buildSquadsProposalCancellation.name, () => {
    it('fails fast for unsupported chain names before cancellation provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(
          'unsupported-chain',
          mpp,
          1n,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chain names before cancellation index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(
          'unsupported-chain',
          mpp,
          -1n,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chain names before malformed cancellation index type validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(
          'unsupported-chain',
          mpp,
          1,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('normalizes padded chain names before cancellation provider lookup', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {
            getAccountInfo: async () => null,
          };
        },
      } as unknown as MultiProtocolProvider;

      const result = await buildSquadsProposalCancellation(
        '  solanamainnet  ',
        mpp,
        1n,
        PublicKey.default,
      );

      expect(providerLookupChain).to.equal('solanamainnet');
      expect(result.instruction).to.not.equal(undefined);
    });

    it('fails fast for malformed chain names before cancellation provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(1, mpp, 1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before cancellation provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation('   ', mpp, 1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before cancellation index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation('   ', mpp, -1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for non-bigint transaction index before cancellation provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(
          'solanamainnet',
          mpp,
          1,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a bigint for solanamainnet, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for null transaction index before cancellation provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(
          'solanamainnet',
          mpp,
          null,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a bigint for solanamainnet, got null',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before transaction index validation in cancellation helper', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(1, mpp, -1n, PublicKey.default),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for negative transaction index before cancellation provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation(
          'solanamainnet',
          mpp,
          -1n,
          PublicKey.default,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative bigint for solanamainnet, got -1',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed cancellation members before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        buildSquadsProposalCancellation('solanamainnet', mpp, 1n, null),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal cancellation member for solanamainnet to be a PublicKey, got null',
      );
      expect(providerLookupCalled).to.equal(false);
    });
  });

  describe(submitProposalToSquads.name, () => {
    it('fails fast for unsupported runtime chains before provider lookup', async () => {
      let providerLookupCalled = false;
      let signerPublicKeyCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('unsupported-chain', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
      expect(signerPublicKeyCalled).to.equal(false);
    });

    it('fails fast for malformed runtime chains before provider lookup', async () => {
      let providerLookupCalled = false;
      let signerPublicKeyCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads(1, [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
      expect(signerPublicKeyCalled).to.equal(false);
    });

    it('fails fast for empty runtime chain names before provider lookup', async () => {
      let providerLookupCalled = false;
      let signerPublicKeyCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('   ', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
      expect(signerPublicKeyCalled).to.equal(false);
    });

    it('fails fast for malformed vault-instruction containers before provider lookup', async () => {
      let providerLookupCalled = false;
      let signerPublicKeyCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads(
          'solanamainnet',
          'malformed-instructions',
          mpp,
          signerAdapter,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal instructions for solanamainnet to be an array, got string',
      );
      expect(providerLookupCalled).to.equal(false);
      expect(signerPublicKeyCalled).to.equal(false);
    });

    it('fails fast for malformed vault-instruction entries before provider lookup', async () => {
      let providerLookupCalled = false;
      let signerPublicKeyCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [{}], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal instructions for solanamainnet[0] to be a TransactionInstruction, got object',
      );
      expect(providerLookupCalled).to.equal(false);
      expect(signerPublicKeyCalled).to.equal(false);
    });

    it('throws contextual error for vault-instruction length getter failures before provider lookup', async () => {
      let providerLookupCalled = false;
      let signerPublicKeyCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
      } as unknown as Parameters<typeof submitProposalToSquads>[3];
      const hostileInstructions = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('length unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads(
          'solanamainnet',
          hostileInstructions,
          mpp,
          signerAdapter,
        ),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read proposal instructions for solanamainnet length: length unavailable',
      );
      expect(providerLookupCalled).to.equal(false);
      expect(signerPublicKeyCalled).to.equal(false);
    });

    it('fails fast for malformed submit memo values before provider lookup', async () => {
      let providerLookupCalled = false;
      let signerPublicKeyCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter, 1),
      );

      expect(thrownError?.message).to.equal(
        'Expected proposal memo for solanamainnet to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
      expect(signerPublicKeyCalled).to.equal(false);
    });

    it('does not request signer public key when provider lookup fails', async () => {
      let signerPublicKeyCalled = false;
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
        buildAndSendTransaction: async () => 'signature',
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to resolve solana provider for solanamainnet: provider lookup failed',
      );
      expect(signerPublicKeyCalled).to.equal(true);
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('normalizes padded chain names before submit provider lookup', async () => {
      let signerPublicKeyCalled = false;
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => {
          signerPublicKeyCalled = true;
          return PublicKey.default;
        },
        buildAndSendTransaction: async () => 'signature',
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('  solanamainnet  ', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to resolve solana provider for solanamainnet: provider lookup failed',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
      expect(signerPublicKeyCalled).to.equal(true);
    });

    it('fails fast when signer adapter does not expose publicKey function', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads(
          'solanamainnet',
          [],
          mpp,
          {} as Parameters<typeof submitProposalToSquads>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Invalid signer adapter for solanamainnet: expected publicKey function, got undefined',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('throws contextual error when signer publicKey accessor fails', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'publicKey') {
              throw new Error('signer unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read signer publicKey for solanamainnet: signer unavailable',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('uses placeholder when signer publicKey accessor throws opaque value', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'publicKey') {
              throw {};
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read signer publicKey for solanamainnet: [unstringifiable error]',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('fails fast when signer publicKey result is not a PublicKey instance', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => 'not-a-public-key',
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Invalid signer public key for solanamainnet: expected PublicKey, got string',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('fails fast when signer publicKey result is promise-like', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => Promise.resolve(PublicKey.default),
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Invalid signer public key for solanamainnet: expected synchronous PublicKey, got promise-like value',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('throws contextual error when signer publicKey promise-like inspection fails', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () =>
          new Proxy(
            {},
            {
              get(target, property, receiver) {
                if (property === 'then') {
                  throw new Error('then unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ),
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to inspect signer public key for solanamainnet: failed to read promise-like then field (then unavailable)',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('fails fast when signer adapter does not expose buildAndSendTransaction function', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => PublicKey.default,
      } as unknown as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Invalid signer adapter for solanamainnet: expected buildAndSendTransaction function, got undefined',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('throws contextual error when signer buildAndSendTransaction accessor fails', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = new Proxy(
        {
          publicKey: () => PublicKey.default,
        },
        {
          get(target, property, receiver) {
            if (property === 'buildAndSendTransaction') {
              throw new Error('send unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read signer buildAndSendTransaction for solanamainnet: send unavailable',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('uses placeholder when signer buildAndSendTransaction accessor throws opaque value', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = new Proxy(
        {
          publicKey: () => PublicKey.default,
        },
        {
          get(target, property, receiver) {
            if (property === 'buildAndSendTransaction') {
              throw {};
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as Parameters<typeof submitProposalToSquads>[3];

      const thrownError = await captureAsyncError(() =>
        submitProposalToSquads('solanamainnet', [], mpp, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read signer buildAndSendTransaction for solanamainnet: [unstringifiable error]',
      );
      expect(providerLookupChain).to.equal(undefined);
    });
  });

  describe(getTransactionType.name, () => {
    it('normalizes padded chain names before account lookup', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {
            getAccountInfo: async () => null,
          };
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('  solanamainnet  ', mpp, 0),
      );

      expect(thrownError?.message).to.include(
        'Transaction account not found at',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('fails fast for unsupported chains before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('unsupported-chain', mpp, 0),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chains before transaction index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('unsupported-chain', mpp, -1),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chains before malformed transaction index type validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('unsupported-chain', mpp, '1'),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType(1, mpp, 0),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('   ', mpp, 0),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before transaction index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('   ', mpp, -1),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before transaction index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType(1, mpp, -1),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for negative transaction index before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, -1),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got -1',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for non-integer transaction index before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, 1.5),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got 1.5',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsafe transaction index before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const unsafeIndex = Number.MAX_SAFE_INTEGER + 1;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, unsafeIndex),
      );

      expect(thrownError?.message).to.equal(
        `Expected transaction index to be a non-negative safe integer for solanamainnet, got ${unsafeIndex}`,
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for NaN transaction index before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, Number.NaN),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got NaN',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for infinite transaction index before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, Number.POSITIVE_INFINITY),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got Infinity',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for string transaction index before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, '1'),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for null transaction index before account lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, null),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got null',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('throws stable error when provider does not expose getAccountInfo function', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {};
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, 0),
      );

      expect(thrownError?.message).to.equal(
        'Invalid solana provider for solanamainnet: expected getAccountInfo function, got undefined',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('throws contextual error when provider getAccountInfo accessor fails', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return new Proxy(
            {},
            {
              get(target, property, receiver) {
                if (property === 'getAccountInfo') {
                  throw new Error('account reader unavailable');
                }
                return Reflect.get(target, property, receiver);
              },
            },
          );
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, 0),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read getAccountInfo for solanamainnet: account reader unavailable',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('uses placeholder when provider getAccountInfo throws opaque value', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {
            getAccountInfo: async () => {
              throw {};
            },
          };
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, 0),
      );

      expect(thrownError?.message).to.include(
        'Failed to fetch transaction account ',
      );
      expect(thrownError?.message).to.include(
        'on solanamainnet: [unstringifiable error]',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('throws contextual error when transaction account data getter throws', async () => {
      let providerLookupChain: string | undefined;
      const accountInfo = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'data') {
              throw new Error('data unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {
            getAccountInfo: async () => accountInfo,
          };
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, 0),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read transaction account data on solanamainnet: data unavailable',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('throws stable error when transaction account data is malformed', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {
            getAccountInfo: async () => ({ data: 'malformed' }),
          };
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, 0),
      );

      expect(thrownError?.message).to.equal(
        'Malformed transaction account data on solanamainnet: expected Uint8Array, got string',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('uses placeholder when transaction account data getter throws opaque value', async () => {
      let providerLookupChain: string | undefined;
      const accountInfo = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'data') {
              throw {};
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {
            getAccountInfo: async () => accountInfo,
          };
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        getTransactionType('solanamainnet', mpp, 0),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read transaction account data on solanamainnet: [unstringifiable error]',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });
  });

  describe(executeProposal.name, () => {
    it('normalizes padded chain names before proposal execution setup', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal('  solanamainnet  ', mpp, 0, {
          buildAndSendTransaction: async () => 'signature',
          publicKey: () => PublicKey.default,
        } as unknown as Parameters<typeof executeProposal>[3]),
      );

      expect(thrownError?.message).to.equal(
        'Failed to resolve solana provider for solanamainnet: provider lookup failed',
      );
      expect(providerLookupChain).to.equal('solanamainnet');
    });

    it('fails fast for unsupported chains before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'unsupported-chain',
          mpp,
          0,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chains before execution index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'unsupported-chain',
          mpp,
          -1,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsupported chains before malformed execution index type validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'unsupported-chain',
          mpp,
          '1',
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(1, mpp, 0, {} as Parameters<typeof executeProposal>[3]),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          '   ',
          mpp,
          0,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for empty chain names before execution index validation', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          '   ',
          mpp,
          -1,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a non-empty string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for malformed chain names before transaction index validation during execution', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          1,
          mpp,
          -1,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected chain name to be a string, got number',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for negative transaction index before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'solanamainnet',
          mpp,
          -1,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got -1',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for non-integer transaction index before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'solanamainnet',
          mpp,
          1.5,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got 1.5',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for unsafe transaction index before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;
      const unsafeIndex = Number.MAX_SAFE_INTEGER + 1;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'solanamainnet',
          mpp,
          unsafeIndex,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        `Expected transaction index to be a non-negative safe integer for solanamainnet, got ${unsafeIndex}`,
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for NaN transaction index before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'solanamainnet',
          mpp,
          Number.NaN,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got NaN',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for infinite transaction index before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'solanamainnet',
          mpp,
          Number.POSITIVE_INFINITY,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got Infinity',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for string transaction index before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'solanamainnet',
          mpp,
          '1',
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got string',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast for null transaction index before proposal execution setup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = await captureAsyncError(() =>
        executeProposal(
          'solanamainnet',
          mpp,
          null,
          {} as Parameters<typeof executeProposal>[3],
        ),
      );

      expect(thrownError?.message).to.equal(
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got null',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('fails fast when execution signer does not expose buildAndSendTransaction function', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        publicKey: () => PublicKey.default,
      } as unknown as Parameters<typeof executeProposal>[3];

      const thrownError = await captureAsyncError(() =>
        executeProposal('solanamainnet', mpp, 0, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Invalid signer adapter for solanamainnet: expected buildAndSendTransaction function, got undefined',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('fails fast when execution signer does not expose publicKey function', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = {
        buildAndSendTransaction: async () => 'signature',
      } as unknown as Parameters<typeof executeProposal>[3];

      const thrownError = await captureAsyncError(() =>
        executeProposal('solanamainnet', mpp, 0, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Invalid signer adapter for solanamainnet: expected publicKey function, got undefined',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('throws contextual error when execution signer publicKey accessor fails', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = new Proxy(
        {
          buildAndSendTransaction: async () => 'signature',
        },
        {
          get(target, property, receiver) {
            if (property === 'publicKey') {
              throw new Error('signer unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Parameters<typeof executeProposal>[3];

      const thrownError = await captureAsyncError(() =>
        executeProposal('solanamainnet', mpp, 0, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read signer publicKey for solanamainnet: signer unavailable',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('throws contextual error when execution signer buildAndSendTransaction accessor fails', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = new Proxy(
        {
          publicKey: () => PublicKey.default,
        },
        {
          get(target, property, receiver) {
            if (property === 'buildAndSendTransaction') {
              throw new Error('send unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Parameters<typeof executeProposal>[3];

      const thrownError = await captureAsyncError(() =>
        executeProposal('solanamainnet', mpp, 0, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read signer buildAndSendTransaction for solanamainnet: send unavailable',
      );
      expect(providerLookupChain).to.equal(undefined);
    });

    it('uses placeholder when execution signer buildAndSendTransaction accessor throws opaque value', async () => {
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return {} as ReturnType<
            MultiProtocolProvider['getSolanaWeb3Provider']
          >;
        },
      } as unknown as MultiProtocolProvider;
      const signerAdapter = new Proxy(
        {
          publicKey: () => PublicKey.default,
        },
        {
          get(target, property, receiver) {
            if (property === 'buildAndSendTransaction') {
              throw {};
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as Parameters<typeof executeProposal>[3];

      const thrownError = await captureAsyncError(() =>
        executeProposal('solanamainnet', mpp, 0, signerAdapter),
      );

      expect(thrownError?.message).to.equal(
        'Failed to read signer buildAndSendTransaction for solanamainnet: [unstringifiable error]',
      );
      expect(providerLookupChain).to.equal(undefined);
    });
  });

  describe('transaction type discriminators', () => {
    it('exports canonical squads discriminator sizing constants', () => {
      expect(SQUADS_DISCRIMINATOR_SIZE).to.equal(8);
      expect(SQUADS_ACCOUNT_DISCRIMINATOR_SIZE).to.equal(8);
      expect(SQUADS_ACCOUNT_DISCRIMINATOR_SIZE).to.equal(
        SQUADS_DISCRIMINATOR_SIZE,
      );
      expect(SQUADS_PROPOSAL_OVERHEAD).to.equal(500);
    });

    it('keeps squads account discriminator byte lengths canonical', () => {
      const discriminatorSets = Object.values(SQUADS_ACCOUNT_DISCRIMINATORS);
      expect(discriminatorSets.length).to.be.greaterThan(0);
      for (const discriminator of discriminatorSets) {
        expect(discriminator).to.have.length(SQUADS_ACCOUNT_DISCRIMINATOR_SIZE);
      }
    });

    it('keeps squads instruction discriminator byte lengths canonical', () => {
      const discriminatorSets = Object.values(
        SQUADS_INSTRUCTION_DISCRIMINATORS,
      );
      expect(discriminatorSets.length).to.be.greaterThan(0);
      for (const discriminator of discriminatorSets) {
        expect(discriminator).to.have.length(SQUADS_DISCRIMINATOR_SIZE);
      }
    });

    it('identifies vault transactions by discriminator', () => {
      const data = Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
        1,
        2,
        3,
      ]);
      expect(isVaultTransaction(data)).to.equal(true);
      expect(isConfigTransaction(data)).to.equal(false);
    });

    it('identifies config transactions by discriminator', () => {
      const data = Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]);
      expect(isConfigTransaction(data)).to.equal(true);
      expect(isVaultTransaction(data)).to.equal(false);
    });

    it('accepts Uint8Array discriminator sources', () => {
      const vaultData = new Uint8Array([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
        9,
      ]);
      const configData = new Uint8Array([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        9,
      ]);

      expect(isVaultTransaction(vaultData)).to.equal(true);
      expect(isConfigTransaction(vaultData)).to.equal(false);
      expect(isConfigTransaction(configData)).to.equal(true);
      expect(isVaultTransaction(configData)).to.equal(false);
    });

    it('throws for malformed discriminator sources', () => {
      expect(() => isVaultTransaction(null)).to.throw(
        'Expected account data to be a Uint8Array, got null',
      );
      expect(() => isConfigTransaction('not-bytes')).to.throw(
        'Expected account data to be a Uint8Array, got string',
      );
      expect(() => isVaultTransaction([])).to.throw(
        'Expected account data to be a Uint8Array, got array',
      );
      expect(() => isConfigTransaction(1)).to.throw(
        'Expected account data to be a Uint8Array, got number',
      );
    });

    it('returns false for truncated discriminator payloads', () => {
      expect(isVaultTransaction(Buffer.from([1, 2, 3]))).to.equal(false);
      expect(isConfigTransaction(Buffer.from([1, 2, 3]))).to.equal(false);
    });
  });

  describe('squads enum and constant tables', () => {
    it('exports canonical squads account-type enum values', () => {
      expect(SquadsAccountType.VAULT).to.equal(0);
      expect(SquadsAccountType.CONFIG).to.equal(1);
    });

    it('exports canonical squads instruction-type and name mappings', () => {
      expect(SquadsInstructionType.ADD_MEMBER).to.equal(0);
      expect(SquadsInstructionType.REMOVE_MEMBER).to.equal(1);
      expect(SquadsInstructionType.CHANGE_THRESHOLD).to.equal(2);
      expect(SquadsInstructionName[SquadsInstructionType.ADD_MEMBER]).to.equal(
        'AddMember',
      );
      expect(
        SquadsInstructionName[SquadsInstructionType.REMOVE_MEMBER],
      ).to.equal('RemoveMember');
      expect(
        SquadsInstructionName[SquadsInstructionType.CHANGE_THRESHOLD],
      ).to.equal('ChangeThreshold');
    });

    it('keeps squads instruction discriminator table aligned with instruction enum', () => {
      const instructionTypeValues = [
        SquadsInstructionType.ADD_MEMBER,
        SquadsInstructionType.REMOVE_MEMBER,
        SquadsInstructionType.CHANGE_THRESHOLD,
      ] as const;
      const discriminatorKeys = Object.keys(
        SQUADS_INSTRUCTION_DISCRIMINATORS,
      ).map(Number);
      expect(discriminatorKeys).to.deep.equal(instructionTypeValues);
      for (const instructionType of instructionTypeValues) {
        expect(SQUADS_INSTRUCTION_DISCRIMINATORS[instructionType]).to.not.equal(
          undefined,
        );
      }
    });

    it('keeps squads account discriminator table aligned with account enum', () => {
      const accountTypeValues = [
        SquadsAccountType.VAULT,
        SquadsAccountType.CONFIG,
      ] as const;
      const accountDiscriminatorKeys = Object.keys(
        SQUADS_ACCOUNT_DISCRIMINATORS,
      ).map(Number);
      expect(accountDiscriminatorKeys).to.deep.equal(accountTypeValues);
      for (const accountType of accountTypeValues) {
        expect(SQUADS_ACCOUNT_DISCRIMINATORS[accountType]).to.not.equal(
          undefined,
        );
      }
    });

    it('keeps canonical squads account discriminator byte values', () => {
      expect(
        Array.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT]),
      ).to.deep.equal([168, 250, 162, 100, 81, 14, 162, 207]);
      expect(
        Array.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG]),
      ).to.deep.equal([94, 8, 4, 35, 113, 139, 139, 112]);
    });

    it('keeps canonical squads instruction discriminator byte values', () => {
      expect(
        Array.from(
          SQUADS_INSTRUCTION_DISCRIMINATORS[SquadsInstructionType.ADD_MEMBER],
        ),
      ).to.deep.equal([105, 59, 69, 187, 29, 191, 111, 175]);
      expect(
        Array.from(
          SQUADS_INSTRUCTION_DISCRIMINATORS[
            SquadsInstructionType.REMOVE_MEMBER
          ],
        ),
      ).to.deep.equal([117, 255, 234, 193, 246, 150, 28, 141]);
      expect(
        Array.from(
          SQUADS_INSTRUCTION_DISCRIMINATORS[
            SquadsInstructionType.CHANGE_THRESHOLD
          ],
        ),
      ).to.deep.equal([134, 5, 181, 153, 254, 178, 214, 132]);
    });

    it('keeps squads instruction-name table aligned with instruction enum', () => {
      const instructionTypeValues = [
        SquadsInstructionType.ADD_MEMBER,
        SquadsInstructionType.REMOVE_MEMBER,
        SquadsInstructionType.CHANGE_THRESHOLD,
      ] as const;
      const instructionNameKeys = Object.keys(SquadsInstructionName).map(
        Number,
      );
      expect(instructionNameKeys).to.deep.equal(instructionTypeValues);
      for (const instructionType of instructionTypeValues) {
        expect(SquadsInstructionName[instructionType]).to.be.a('string');
      }
    });

    it('exports canonical squads permission bit flags', () => {
      expect(SquadsPermission.PROPOSER).to.equal(1);
      expect(SquadsPermission.VOTER).to.equal(2);
      expect(SquadsPermission.EXECUTOR).to.equal(4);
      expect(SquadsPermission.ALL_PERMISSIONS).to.equal(7);
      expect(
        SquadsPermission.PROPOSER |
          SquadsPermission.VOTER |
          SquadsPermission.EXECUTOR,
      ).to.equal(SquadsPermission.ALL_PERMISSIONS);
    });

    it('decodes all canonical squads permission combinations', () => {
      expect(decodePermissions(0)).to.equal('None');
      expect(decodePermissions(1)).to.equal('Proposer');
      expect(decodePermissions(2)).to.equal('Voter');
      expect(decodePermissions(3)).to.equal('Proposer, Voter');
      expect(decodePermissions(4)).to.equal('Executor');
      expect(decodePermissions(5)).to.equal('Proposer, Executor');
      expect(decodePermissions(6)).to.equal('Voter, Executor');
      expect(decodePermissions(7)).to.equal('Proposer, Voter, Executor');
    });
  });

  describe(getSquadsKeys.name, () => {
    it('returns public keys for configured chain', () => {
      const keys = getSquadsKeys('solanamainnet');
      expect(keys.multisigPda.toBase58().length).to.be.greaterThan(0);
      expect(keys.programId.toBase58().length).to.be.greaterThan(0);
      expect(keys.vault.toBase58().length).to.be.greaterThan(0);
    });

    it('normalizes surrounding whitespace when looking up configured chains', () => {
      const trimmedKeys = getSquadsKeys('solanamainnet');
      const paddedKeys = getSquadsKeys('  solanamainnet  ');

      expect(paddedKeys.multisigPda.toBase58()).to.equal(
        trimmedKeys.multisigPda.toBase58(),
      );
      expect(paddedKeys.programId.toBase58()).to.equal(
        trimmedKeys.programId.toBase58(),
      );
      expect(paddedKeys.vault.toBase58()).to.equal(
        trimmedKeys.vault.toBase58(),
      );
    });

    it('throws for unknown chain', () => {
      expect(() => getSquadsKeys('unknown-chain')).to.throw(
        'Squads config not found on chain unknown-chain',
      );
    });

    it('throws for empty chain-name values after trimming', () => {
      expect(() => getSquadsKeys('   ')).to.throw(
        'Expected chain name to be a non-empty string',
      );
    });

    it('resolves keys for every configured squads chain', () => {
      for (const chain of getSquadsChains()) {
        const keys = getSquadsKeys(chain);
        expect(keys.multisigPda.toBase58()).to.equal(
          squadsConfigs[chain].multisigPda,
        );
        expect(keys.programId.toBase58()).to.equal(
          squadsConfigs[chain].programId,
        );
        expect(keys.vault.toBase58()).to.equal(squadsConfigs[chain].vault);
      }
    });

    it('returns a fresh keys container on every call', () => {
      const firstKeys = getSquadsKeys('solanamainnet');
      const secondKeys = getSquadsKeys('solanamainnet');

      expect(firstKeys).to.not.equal(secondKeys);
      expect(Object.isFrozen(firstKeys)).to.equal(true);
      expect(Object.isFrozen(secondKeys)).to.equal(true);
      expect(firstKeys.multisigPda.toBase58()).to.equal(
        secondKeys.multisigPda.toBase58(),
      );
    });

    it('does not leak caller mutation between key lookups', () => {
      const mutableKeys = getSquadsKeys('solanamainnet') as unknown as {
        multisigPda: PublicKey;
        programId: PublicKey;
        vault: PublicKey;
      };
      const originalVault = mutableKeys.vault.toBase58();
      let threwOnMutation = false;
      try {
        mutableKeys.vault = PublicKey.default;
      } catch {
        threwOnMutation = true;
      }

      expect(threwOnMutation).to.equal(true);
      const reloadedKeys = getSquadsKeys('solanamainnet');
      expect(reloadedKeys.vault.toBase58()).to.equal(originalVault);
    });
  });

  it('keeps expected canonical squads chain config table', () => {
    expect(squadsConfigs).to.deep.equal({
      solanamainnet: {
        programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
        multisigPda: 'EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4',
        vault: '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa',
      },
      soon: {
        programId: 'Hz8Zg8JYFshThnKHXSZV9XJFbyYUUKBb5NJUrxDvF8PB',
        multisigPda: '3tQm2hkauvqoRsfJg6NmUA6eMEWqFdvbiJUZUBFHXD6A',
        vault: '7Y6WDpMfNeb1b4YYbyUkF41z1DuPhvDDuWWJCHPRNa9Y',
      },
      eclipsemainnet: {
        programId: 'eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f',
        multisigPda: 'CSnrKeqrrLm6v9NvChYKT58mfRGYnMk8MeLGWhKvBdbk',
        vault: 'D742EWw9wpV47jRAvEenG1oWHfMmpiQNJLjHTBfXhuRm',
      },
      sonicsvm: {
        programId: 'sqdsFBUUwbsuoLUhoWdw343Je6mvn7dGVVRYCa4wtqJ',
        multisigPda: 'BsdNMofu1a4ncHFJSNZWuTcZae9yt4ZGDuaneN5am5m6',
        vault: '8ECSwp5yo2EeZkozSrpPnMj5Rmcwa4VBYCETE9LHmc9y',
      },
      solaxy: {
        programId: '222DRw2LbM7xztYq1efxcbfBePi6xnv27o7QBGm9bpts',
        multisigPda: 'XgeE3uXEy5bKPbgYv3D9pWovhu3PWrxt3RR5bdp9RkW',
        vault: '4chV16Dea6CW6xyQcHj9RPwBZitfxYgpafkSoZgzy4G8',
      },
    });
  });

  it('keeps squads chain config table deeply frozen and mutation-safe', () => {
    expect(Object.isFrozen(squadsConfigs)).to.equal(true);
    for (const chain of getSquadsChains()) {
      expect(Object.isFrozen(squadsConfigs[chain])).to.equal(true);
    }

    const originalProgramId = squadsConfigs.solanamainnet.programId;
    const mutableConfigs = squadsConfigs as {
      solanamainnet: { programId: string };
    };
    let threwOnMutation = false;
    try {
      mutableConfigs.solanamainnet.programId = 'mutated-value';
    } catch {
      threwOnMutation = true;
    }
    expect(threwOnMutation).to.equal(true);
    expect(squadsConfigs.solanamainnet.programId).to.equal(originalProgramId);
  });

  it('returns configured squads chains', () => {
    const chains = getSquadsChains();
    expect(chains).to.include('solanamainnet');
    expect(chains.length).to.be.greaterThan(0);
  });

  it('keeps expected canonical squads chain ordering', () => {
    expect(getSquadsChains()).to.deep.equal([
      'solanamainnet',
      'soon',
      'eclipsemainnet',
      'sonicsvm',
      'solaxy',
    ]);
  });

  it('returns chain list matching squads config keys', () => {
    expect(getSquadsChains()).to.deep.equal(Object.keys(squadsConfigs));
  });

  it('returns a defensive copy of squads chains', () => {
    const chains = getSquadsChains();
    chains.pop();
    expect(getSquadsChains()).to.include('solanamainnet');
  });

  it('returns a fresh squads chains array reference per call', () => {
    const firstChains = getSquadsChains();
    const secondChains = getSquadsChains();

    expect(firstChains).to.not.equal(secondChains);
  });

  it('detects whether a chain has squads config', () => {
    expect(isSquadsChain('solanamainnet')).to.equal(true);
    expect(isSquadsChain('not-a-squads-chain')).to.equal(false);
    expect(isSquadsChain('__proto__')).to.equal(false);
  });

  it('asserts whether a chain has squads config', () => {
    expect(() => assertIsSquadsChain('solanamainnet')).to.not.throw();
    expect(() => assertIsSquadsChain('not-a-squads-chain')).to.throw(
      'Squads config not found on chain not-a-squads-chain',
    );
  });

  it('partitions chains into squads and non-squads', () => {
    const { squadsChains, nonSquadsChains } = partitionSquadsChains([
      'solanamainnet',
      'unknown-chain',
    ]);
    expect(squadsChains).to.deep.equal(['solanamainnet']);
    expect(nonSquadsChains).to.deep.equal(['unknown-chain']);
  });

  it('deduplicates chains when partitioning', () => {
    const { squadsChains, nonSquadsChains } = partitionSquadsChains([
      'solanamainnet',
      'solanamainnet',
      'unknown-chain',
      'unknown-chain',
    ]);
    expect(squadsChains).to.deep.equal(['solanamainnet']);
    expect(nonSquadsChains).to.deep.equal(['unknown-chain']);
  });

  it('normalizes whitespace while partitioning chains', () => {
    const { squadsChains, nonSquadsChains } = partitionSquadsChains([
      ' solanamainnet ',
      'unknown-chain',
      ' unknown-chain ',
      '   ',
    ]);
    expect(squadsChains).to.deep.equal(['solanamainnet']);
    expect(nonSquadsChains).to.deep.equal(['unknown-chain', '']);
  });

  it('preserves first-seen chain ordering while partitioning', () => {
    const { squadsChains, nonSquadsChains } = partitionSquadsChains([
      'unknown-b',
      'solanamainnet',
      'unknown-a',
      'soon',
      'unknown-b',
      'solanamainnet',
      'unknown-c',
    ]);

    expect(squadsChains).to.deep.equal(['solanamainnet', 'soon']);
    expect(nonSquadsChains).to.deep.equal([
      'unknown-b',
      'unknown-a',
      'unknown-c',
    ]);
  });

  it('does not mutate the caller-provided chains while partitioning', () => {
    const chains = ['solanamainnet', 'unknown-chain', 'solanamainnet'];

    void partitionSquadsChains(chains);

    expect(chains).to.deep.equal([
      'solanamainnet',
      'unknown-chain',
      'solanamainnet',
    ]);
  });

  it('supports readonly frozen chain arrays while partitioning', () => {
    const chains = Object.freeze([
      'solanamainnet',
      'unknown-chain',
      'solanamainnet',
    ]) as readonly string[];

    const { squadsChains, nonSquadsChains } = partitionSquadsChains(chains);

    expect(squadsChains).to.deep.equal(['solanamainnet']);
    expect(nonSquadsChains).to.deep.equal(['unknown-chain']);
  });

  it('throws for non-string chain entries while partitioning', () => {
    expect(() => partitionSquadsChains(['solanamainnet', null])).to.throw(
      'Expected partitioned squads chains[1] to be a string, got null',
    );
  });

  it('throws for non-array partition inputs', () => {
    expect(() => partitionSquadsChains('solanamainnet')).to.throw(
      'Expected partitioned squads chains to be an array, got string',
    );
  });

  it('resolves squads chains to configured defaults when input omitted', () => {
    expect(resolveSquadsChains()).to.deep.equal(getSquadsChains());
  });

  it('resolves squads chains to configured defaults when input is empty array', () => {
    expect(resolveSquadsChains([])).to.deep.equal(getSquadsChains());
  });

  it('returns a fresh default squads chain array per resolve call', () => {
    const firstResolvedChains = resolveSquadsChains();
    const secondResolvedChains = resolveSquadsChains();

    expect(firstResolvedChains).to.not.equal(secondResolvedChains);
  });

  it('resolves explicit squads chains while deduplicating and preserving order', () => {
    const [firstChain, secondChain] = getSquadsChains();
    expect(
      resolveSquadsChains([firstChain, secondChain, firstChain]),
    ).to.deep.equal([firstChain, secondChain]);
  });

  it('trims explicit squads chain names before resolving', () => {
    const [firstChain] = getSquadsChains();
    expect(resolveSquadsChains([` ${firstChain} `])).to.deep.equal([
      firstChain,
    ]);
  });

  it('deduplicates explicit squads chain names after trimming', () => {
    const [firstChain] = getSquadsChains();
    expect(
      resolveSquadsChains([` ${firstChain}`, `${firstChain} `]),
    ).to.deep.equal([firstChain]);
  });

  it('does not mutate caller-provided explicit squads chains', () => {
    const [firstChain, secondChain] = getSquadsChains();
    const explicitChains = [firstChain, secondChain, firstChain];

    void resolveSquadsChains(explicitChains);

    expect(explicitChains).to.deep.equal([firstChain, secondChain, firstChain]);
  });

  it('throws for explicit non-squads chains', () => {
    expect(() => resolveSquadsChains(['ethereum'])).to.throw(
      'Squads configuration not found for chains: ethereum',
    );
  });

  it('throws for explicit non-string squads chain entries', () => {
    expect(() => resolveSquadsChains(['solanamainnet', 1])).to.throw(
      'Expected squads chains[1] to be a string, got number',
    );
  });

  it('throws for non-array explicit squads chain inputs', () => {
    expect(() => resolveSquadsChains('solanamainnet')).to.throw(
      'Expected squads chains to be an array, got string',
    );
    expect(() => resolveSquadsChains(null)).to.throw(
      'Expected squads chains to be an array, got null',
    );
  });

  it('labels array-valued explicit squads chain entries clearly', () => {
    expect(() => resolveSquadsChains(['solanamainnet', []])).to.throw(
      'Expected squads chains[1] to be a string, got array',
    );
  });

  it('surfaces empty chain names as unsupported entries after trimming', () => {
    expect(() => resolveSquadsChains(['   '])).to.throw(
      'Squads configuration not found for chains: <empty>',
    );
  });

  it('formats unsupported squads chain errors with trimmed deduplicated chain names', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        [' ethereum ', '', ''],
        [' solanamainnet ', ''],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum, <empty>. Available Squads chains: solanamainnet, <empty>',
    );
  });

  it('uses default configured squads chains when formatter list is omitted', () => {
    const availableChains = getSquadsChains().join(', ');
    expect(getUnsupportedSquadsChainsErrorMessage(['ethereum'])).to.equal(
      `Squads configuration not found for chains: ethereum. Available Squads chains: ${availableChains}`,
    );
  });

  it('deduplicates unsupported and configured chains in formatter output', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        ['ethereum', 'ethereum'],
        ['solanamainnet', 'solanamainnet'],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum. Available Squads chains: solanamainnet',
    );
  });

  it('throws for non-string unsupported chain entries in formatter input', () => {
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(['ethereum', null]),
    ).to.throw(
      'Expected unsupported squads chains[1] to be a string, got null',
    );
  });

  it('throws for non-array unsupported chain formatter input', () => {
    expect(() => getUnsupportedSquadsChainsErrorMessage('ethereum')).to.throw(
      'Expected unsupported squads chains to be an array, got string',
    );
  });

  it('throws for non-string configured chain entries in formatter input', () => {
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(
        ['ethereum'],
        ['solanamainnet', {}],
      ),
    ).to.throw(
      'Expected configured squads chains[1] to be a string, got object',
    );
  });

  it('throws for non-array configured chain formatter input', () => {
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(['ethereum'], 'solanamainnet'),
    ).to.throw('Expected configured squads chains to be an array, got string');
  });

  it('labels symbol-valued unsupported chain entries in formatter input', () => {
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(['ethereum', Symbol('bad-chain')]),
    ).to.throw(
      'Expected unsupported squads chains[1] to be a string, got symbol',
    );
  });

  it('keeps formatter dedupe and ordering canonical after chain-name normalization', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        ['  ethereum  ', '', 'ethereum', '  ', 'soon'],
        ['', ' solanamainnet ', 'solanamainnet', ''],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum, <empty>, soon. Available Squads chains: <empty>, solanamainnet',
    );
  });

  it('fails fast when unsupported-chain formatter receives empty inputs', () => {
    expect(() => getUnsupportedSquadsChainsErrorMessage([])).to.throw(
      'Expected at least one unsupported squads chain to format error message',
    );
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(['ethereum'], []),
    ).to.throw('Expected at least one configured squads chain');
  });

  it('exports canonical proposal statuses', () => {
    expect(SquadsProposalStatus.Active).to.equal('Active');
  });

  it('detects terminal squads proposal statuses', () => {
    expect(isTerminalSquadsProposalStatus(SquadsProposalStatus.Executed)).to.eq(
      true,
    );
    expect(isTerminalSquadsProposalStatus(SquadsProposalStatus.Rejected)).to.eq(
      true,
    );
    expect(
      isTerminalSquadsProposalStatus(` ${SquadsProposalStatus.Cancelled} `),
    ).to.eq(true);
    expect(isTerminalSquadsProposalStatus(SquadsProposalStatus.Active)).to.eq(
      false,
    );
  });

  it('fails fast for invalid terminal-status helper inputs', () => {
    expect(() => isTerminalSquadsProposalStatus('   ')).to.throw(
      'Expected status kind to be a non-empty string',
    );
    expect(() => isTerminalSquadsProposalStatus(1)).to.throw(
      'Expected status kind to be a string, got number',
    );
  });

  it('detects modifiable squads proposal statuses', () => {
    expect(canModifySquadsProposalStatus(SquadsProposalStatus.Active)).to.eq(
      true,
    );
    expect(canModifySquadsProposalStatus(SquadsProposalStatus.Approved)).to.eq(
      true,
    );
    expect(canModifySquadsProposalStatus(SquadsProposalStatus.Executed)).to.eq(
      false,
    );
    expect(canModifySquadsProposalStatus(' Draft ')).to.eq(false);
  });

  it('fails fast for invalid modifiable-status helper inputs', () => {
    expect(() => canModifySquadsProposalStatus('')).to.throw(
      'Expected status kind to be a non-empty string',
    );
    expect(() => canModifySquadsProposalStatus(null)).to.throw(
      'Expected status kind to be a string, got object',
    );
  });

  it('derives proposal modification actions from status', () => {
    expect(
      deriveSquadsProposalModification(SquadsProposalStatus.Active),
    ).to.deep.equal({
      action: 'reject',
      pastTenseAction: 'rejected',
    });
    expect(
      deriveSquadsProposalModification(` ${SquadsProposalStatus.Approved} `),
    ).to.deep.equal({
      action: 'cancel',
      pastTenseAction: 'cancelled',
    });
    expect(deriveSquadsProposalModification(SquadsProposalStatus.Draft)).to.eq(
      undefined,
    );
  });

  it('fails fast for invalid proposal-modification helper inputs', () => {
    expect(() => deriveSquadsProposalModification('   ')).to.throw(
      'Expected status kind to be a non-empty string',
    );
    expect(() => deriveSquadsProposalModification(null)).to.throw(
      'Expected status kind to be a string, got object',
    );
  });

  it('detects stale squads proposals only for non-terminal statuses', () => {
    expect(isStaleSquadsProposal(SquadsProposalStatus.Active, 3, 4)).to.equal(
      true,
    );
    expect(isStaleSquadsProposal(SquadsProposalStatus.Executed, 3, 4)).to.equal(
      false,
    );
    expect(
      isStaleSquadsProposal(` ${SquadsProposalStatus.Cancelled} `, 3, 4),
    ).to.equal(false);
    expect(isStaleSquadsProposal(SquadsProposalStatus.Active, 4, 4)).to.equal(
      false,
    );
  });

  it('fails fast for invalid stale helper transaction indexes', () => {
    expect(() =>
      isStaleSquadsProposal(SquadsProposalStatus.Active, -1, 0),
    ).to.throw(
      'Expected transaction index to be a non-negative safe integer, got -1',
    );
    expect(() =>
      isStaleSquadsProposal(SquadsProposalStatus.Active, 0, Number.NaN),
    ).to.throw(
      'Expected stale transaction index to be a non-negative safe integer, got NaN',
    );
    expect(() => isStaleSquadsProposal('   ', 0, 0)).to.throw(
      'Expected status kind to be a non-empty string',
    );
    expect(() =>
      isStaleSquadsProposal(SquadsProposalStatus.Active, '1', 0),
    ).to.throw(
      'Expected transaction index to be a non-negative safe integer, got string',
    );
    expect(() =>
      isStaleSquadsProposal(SquadsProposalStatus.Active, 0, null),
    ).to.throw(
      'Expected stale transaction index to be a non-negative safe integer, got null',
    );
  });

  it('tracks pending squads proposals only when status is pending, non-stale, and unrejected', () => {
    expect(
      shouldTrackPendingSquadsProposal(SquadsProposalStatus.Active, 5, 4, 0),
    ).to.equal(true);
    expect(
      shouldTrackPendingSquadsProposal(SquadsProposalStatus.Approved, 5, 4, 1),
    ).to.equal(false);
    expect(
      shouldTrackPendingSquadsProposal(SquadsProposalStatus.Executed, 5, 4, 0),
    ).to.equal(false);
    expect(
      shouldTrackPendingSquadsProposal(SquadsProposalStatus.Active, 3, 4, 0),
    ).to.equal(false);
  });

  it('fails fast for invalid pending-proposal rejection counts', () => {
    expect(() =>
      shouldTrackPendingSquadsProposal(
        SquadsProposalStatus.Active,
        5,
        4,
        Number.NaN,
      ),
    ).to.throw(
      'Expected rejections to be a non-negative safe integer, got NaN',
    );
    expect(() =>
      shouldTrackPendingSquadsProposal(SquadsProposalStatus.Active, 5, 4, -1),
    ).to.throw('Expected rejections to be a non-negative safe integer, got -1');
    expect(() =>
      shouldTrackPendingSquadsProposal(SquadsProposalStatus.Active, 5, 4, '0'),
    ).to.throw(
      'Expected rejections to be a non-negative safe integer, got string',
    );
  });
});
