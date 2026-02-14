import { expect } from 'chai';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { SquadsTransactionReader } from './transaction-reader.js';

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
    });
  }
});
