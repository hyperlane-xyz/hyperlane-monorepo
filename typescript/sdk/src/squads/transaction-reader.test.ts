import { expect } from 'chai';
import { PublicKey } from '@solana/web3.js';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { SquadsTransactionReader } from './transaction-reader.js';
import { SquadsAccountType, SQUADS_ACCOUNT_DISCRIMINATORS } from './utils.js';

function createReaderWithLookupCounter(): {
  reader: SquadsTransactionReader;
  getLookupCount: () => number;
} {
  let lookupCount = 0;
  const mpp = {
    getSolanaWeb3Provider: () => {
      lookupCount += 1;
      throw new Error('provider lookup should not run for invalid indices');
    },
  } as unknown as MultiProtocolProvider;

  const reader = new SquadsTransactionReader(mpp, {
    resolveCoreProgramIds: () => ({
      mailbox: 'mailbox-program-id',
      multisig_ism_message_id: 'multisig-ism-program-id',
    }),
  });

  return {
    reader,
    getLookupCount: () => lookupCount,
  };
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

describe('squads transaction reader', () => {
  function createMockProposalData(
    transactionIndex: unknown,
  ): Record<string, unknown> {
    return {
      proposal: {
        status: { __kind: 'Active' },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex,
      },
      proposalPda: new PublicKey('11111111111111111111111111111111'),
      multisigPda: new PublicKey('11111111111111111111111111111111'),
      programId: new PublicKey('11111111111111111111111111111111'),
    };
  }

  const invalidTransactionIndexCases: Array<{
    title: string;
    transactionIndex: number;
    expectedMessage: string;
  }> = [
    {
      title: 'fails fast for negative transaction index',
      transactionIndex: -1,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got -1',
    },
    {
      title: 'fails fast for non-integer transaction index',
      transactionIndex: 1.5,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got 1.5',
    },
    {
      title: 'fails fast for unsafe transaction index',
      transactionIndex: Number.MAX_SAFE_INTEGER + 1,
      expectedMessage: `Expected transaction index to be a non-negative safe integer for solanamainnet, got ${
        Number.MAX_SAFE_INTEGER + 1
      }`,
    },
    {
      title: 'fails fast for NaN transaction index',
      transactionIndex: Number.NaN,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got NaN',
    },
    {
      title: 'fails fast for infinite transaction index',
      transactionIndex: Number.POSITIVE_INFINITY,
      expectedMessage:
        'Expected transaction index to be a non-negative safe integer for solanamainnet, got Infinity',
    },
  ];

  for (const {
    title,
    transactionIndex,
    expectedMessage,
  } of invalidTransactionIndexCases) {
    it(title, async () => {
      const { reader, getLookupCount } = createReaderWithLookupCounter();
      const thrownError = await captureAsyncError(() =>
        reader.read('solanamainnet', transactionIndex),
      );

      expect(thrownError?.message).to.equal(expectedMessage);
      expect(getLookupCount()).to.equal(0);
      expect(reader.errors).to.deep.equal([]);
    });
  }

  it('uses requested transaction index when reading config transaction', async () => {
    const reader = new SquadsTransactionReader(
      {} as unknown as MultiProtocolProvider,
      {
        resolveCoreProgramIds: () => ({
          mailbox: 'mailbox-program-id',
          multisig_ism_message_id: 'multisig-ism-program-id',
        }),
      },
    );
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readConfigTransaction: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
    };

    readerAny.fetchProposalData = async () =>
      createMockProposalData({
        [Symbol.toPrimitive]: () => '5',
        toString: () => {
          throw new Error('proposal transactionIndex should not stringify');
        },
      });

    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        1,
      ]),
    });

    let observedTransactionIndex: number | undefined;
    readerAny.readConfigTransaction = async (_, transactionIndex) => {
      observedTransactionIndex = transactionIndex;
      return { chain: 'solanamainnet', transactionIndex };
    };

    const result = (await reader.read('solanamainnet', 5)) as {
      transactionIndex?: number;
    };

    expect(result.transactionIndex).to.equal(5);
    expect(observedTransactionIndex).to.equal(5);
  });

  it('fails before account lookup when proposal index mismatches request', async () => {
    const reader = new SquadsTransactionReader(
      {} as unknown as MultiProtocolProvider,
      {
        resolveCoreProgramIds: () => ({
          mailbox: 'mailbox-program-id',
          multisig_ism_message_id: 'multisig-ism-program-id',
        }),
      },
    );
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(7);

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Expected proposal index 5 for solanamainnet, got 7',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'Error: Expected proposal index 5 for solanamainnet, got 7',
      },
    ]);
  });

  it('fails before account lookup when proposal index is invalid', async () => {
    const reader = new SquadsTransactionReader(
      {} as unknown as MultiProtocolProvider,
      {
        resolveCoreProgramIds: () => ({
          mailbox: 'mailbox-program-id',
          multisig_ism_message_id: 'multisig-ism-program-id',
        }),
      },
    );
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(true);

    let fetchTransactionAccountCalled = false;
    readerAny.fetchTransactionAccount = async () => {
      fetchTransactionAccountCalled = true;
      return {
        data: Buffer.from([
          ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
          1,
        ]),
      };
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal(
      'Squads transaction index must be a JavaScript safe integer: true',
    );
    expect(fetchTransactionAccountCalled).to.equal(false);
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error:
          'Error: Squads transaction index must be a JavaScript safe integer: true',
      },
    ]);
  });

  it('records exactly one error when vault transaction read fails', async () => {
    const reader = new SquadsTransactionReader(
      {} as unknown as MultiProtocolProvider,
      {
        resolveCoreProgramIds: () => ({
          mailbox: 'mailbox-program-id',
          multisig_ism_message_id: 'multisig-ism-program-id',
        }),
      },
    );
    const readerAny = reader as unknown as {
      fetchProposalData: (
        chain: string,
        transactionIndex: number,
      ) => Promise<Record<string, unknown>>;
      fetchTransactionAccount: () => Promise<{ data: Buffer }>;
      readVaultTransaction: () => Promise<unknown>;
    };

    readerAny.fetchProposalData = async () => createMockProposalData(5);
    readerAny.fetchTransactionAccount = async () => ({
      data: Buffer.from([
        ...SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
        1,
      ]),
    });
    readerAny.readVaultTransaction = async () => {
      throw new Error('vault read failed');
    };

    const thrownError = await captureAsyncError(() =>
      reader.read('solanamainnet', 5),
    );

    expect(thrownError?.message).to.equal('vault read failed');
    expect(reader.errors).to.deep.equal([
      {
        chain: 'solanamainnet',
        transactionIndex: 5,
        error: 'Error: vault read failed',
      },
    ]);
  });
});
