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
  getSquadProposal,
  getSquadTxStatus,
  isConfigTransaction,
  parseSquadsProposalVoteError,
  parseSquadsProposalVoteErrorFromError,
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
  describe(getSquadTxStatus.name, () => {
    it('returns stale for stale non-executed proposal', () => {
      expect(getSquadTxStatus('Active', 0, 2, 5, 10)).to.equal(
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

    it('throws when transaction index exceeds JavaScript safe integer range', () => {
      const parseUnsafeProposal = () =>
        parseSquadProposal({
          status: { __kind: SquadsProposalStatus.Active },
          approved: [],
          rejected: [],
          cancelled: [],
          transactionIndex: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        } as unknown as Parameters<typeof parseSquadProposal>[0]);

      expect(parseUnsafeProposal).to.throw(
        'Squads transaction index exceeds JavaScript safe integer range',
      );
    });

    it('throws when status timestamp exceeds JavaScript safe integer range', () => {
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
        'Squads status timestamp exceeds JavaScript safe integer range',
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

    it('prefers transactionLogs over logs when both contain known errors', () => {
      const error = {
        transactionLogs: ['custom program error: 0x177c'],
        logs: ['custom program error: 0x177b'],
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
      );
    });

    it('uses logs when transactionLogs is present but not an array', () => {
      const error = {
        transactionLogs: 'custom program error: 0x177b',
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

    it('parses known vote error from string originalError field', () => {
      const error = {
        originalError: 'Program log: AlreadyCancelled',
      };
      expect(parseSquadsProposalVoteErrorFromError(error)).to.equal(
        SquadsProposalVoteError.AlreadyCancelled,
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
