import { expect } from 'chai';
import { PublicKey } from '@solana/web3.js';

import {
  SquadTxStatus,
  SquadsAccountType,
  SquadsProposalVoteError,
  SquadsPermission,
  SquadsProposalStatus,
  SQUADS_ACCOUNT_DISCRIMINATORS,
  decodePermissions,
  getSquadAndProvider,
  getMinimumProposalIndexToCheck,
  getSquadProposal,
  getSquadTxStatus,
  isConfigTransaction,
  parseSquadsProposalVoteError,
  parseSquadsProposalVoteErrorFromError,
  parseSquadMultisig,
  parseSquadProposal,
  isVaultTransaction,
} from './utils.js';
import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import {
  assertIsSquadsChain,
  getSquadsChains,
  getSquadsKeys,
  isSquadsChain,
  partitionSquadsChains,
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

describe('squads utils', () => {
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
  });

  describe(parseSquadProposal.name, () => {
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

  describe(parseSquadMultisig.name, () => {
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
          threshold: { toString: () => {
            throw new Error('boom');
          } },
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
  });

  describe(parseSquadsProposalVoteError.name, () => {
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
  });

  describe(parseSquadsProposalVoteErrorFromError.name, () => {
    it('parses known vote error from string error values', () => {
      expect(
        parseSquadsProposalVoteErrorFromError(
          'custom program error: 0x177b',
        ),
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
        parseSquadsProposalVoteErrorFromError([
          'Program log: unrelated',
          999,
        ]),
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

    it('parses known vote error from aggregate errors array', () => {
      const error = {
        errors: [
          { message: 'unrelated' },
          'custom program error: 0x177a',
        ],
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
      const provider = { provider: 'solana' };
      let providerLookupChain: string | undefined;
      const mpp = {
        getSolanaWeb3Provider: (chain: string) => {
          providerLookupChain = chain;
          return provider;
        },
      } as unknown as MultiProtocolProvider;

      const { svmProvider, vault, multisigPda, programId } = getSquadAndProvider(
        supportedChain,
        mpp,
      );

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

    it('fails fast for unsupported chains before provider lookup', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup should not execute');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('unsupported-chain', mpp),
      );

      expect(thrownError?.message).to.include(
        'Squads config not found on chain unsupported-chain',
      );
      expect(providerLookupCalled).to.equal(false);
    });

    it('propagates provider lookup failures for supported chains', async () => {
      let providerLookupCalled = false;
      const mpp = {
        getSolanaWeb3Provider: () => {
          providerLookupCalled = true;
          throw new Error('provider lookup failed');
        },
      } as unknown as MultiProtocolProvider;

      const thrownError = captureSyncError(() =>
        getSquadAndProvider('solanamainnet', mpp),
      );

      expect(thrownError?.message).to.include('provider lookup failed');
      expect(providerLookupCalled).to.equal(true);
    });
  });

  describe(getSquadProposal.name, () => {
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
  });

  describe('transaction type discriminators', () => {
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
  });

  describe(getSquadsKeys.name, () => {
    it('returns public keys for configured chain', () => {
      const keys = getSquadsKeys('solanamainnet');
      expect(keys.multisigPda.toBase58().length).to.be.greaterThan(0);
      expect(keys.programId.toBase58().length).to.be.greaterThan(0);
      expect(keys.vault.toBase58().length).to.be.greaterThan(0);
    });

    it('throws for unknown chain', () => {
      expect(() => getSquadsKeys('unknown-chain')).to.throw(
        'Squads config not found on chain unknown-chain',
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
  });

  it('returns configured squads chains', () => {
    const chains = getSquadsChains();
    expect(chains).to.include('solanamainnet');
    expect(chains.length).to.be.greaterThan(0);
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

  it('exports canonical proposal statuses', () => {
    expect(SquadsProposalStatus.Active).to.equal('Active');
  });
});
