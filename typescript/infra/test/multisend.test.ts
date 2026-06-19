import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { SafeTransaction } from '@safe-global/types-kit';
import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { CallData } from '@hyperlane-xyz/utils';

import {
  SAFE_NONCE_OVERRIDES,
  SafeMultiSend,
} from '../src/govern/multisend.js';

const chain: ChainName = 'testchain';
const safeAddress = '0x1234567890123456789012345678901234567890';
const multiSendAddress = '0x00000000000000000000000000000000000000aa';
const signerAddress = '0x00000000000000000000000000000000000000bb';

type CreatedTransaction = {
  transactions: unknown[];
  onlyCalls?: boolean;
  nonce?: number;
};

type SafeTransactionInput = {
  transactions: unknown[];
  onlyCalls?: boolean;
  options?: { nonce: number };
};

type SafeMultiSendConstructor = new (
  multiProvider: MultiProvider,
  chain: ChainName,
  safeAddress: string,
  safeSdk: Safe.default,
  safeService: SafeApiKit.default,
) => SafeMultiSend;

function createCalls(count: number): CallData[] {
  return Array.from({ length: count }, (_, index) => ({
    to: `0x${(0xc0 + index).toString(16).padStart(40, '0')}`,
    data: '0x',
    value: BigNumber.from(index),
  }));
}

function createSafeMultiSend({
  safeMultiSendAddress,
  nextNonce,
}: {
  safeMultiSendAddress: string;
  nextNonce: string | number;
}) {
  const createdTransactions: CreatedTransaction[] = [];
  const proposedTransactions: unknown[] = [];
  let getNextNonceCalls = 0;

  const safeSdk = {
    getMultiSendAddress: () => safeMultiSendAddress,
    createTransaction: async ({
      transactions,
      onlyCalls,
      options,
    }: SafeTransactionInput) => {
      const safeTransaction = {
        data: {
          nonce: options?.nonce,
        },
      } as SafeTransaction;
      createdTransactions.push({
        transactions,
        onlyCalls,
        nonce: options?.nonce,
      });
      return safeTransaction;
    },
    getTransactionHash: async (safeTransaction: SafeTransaction) => {
      const transaction = safeTransaction as SafeTransaction & {
        data: { nonce: number };
      };
      return `hash-${transaction.data.nonce}`;
    },
    signTypedData: async () => ({ data: '0xsig' }),
  } as unknown as Safe.default;

  const safeService = {
    getNextNonce: async () => {
      getNextNonceCalls += 1;
      return nextNonce;
    },
    proposeTransaction: async (transaction: unknown) => {
      proposedTransactions.push(transaction);
    },
  } as unknown as SafeApiKit.default;

  const multiProvider = {
    getSigner: () => ({
      getAddress: async () => signerAddress,
    }),
  } as unknown as MultiProvider;
  const safeMultiSendConstructor =
    SafeMultiSend as unknown as SafeMultiSendConstructor;

  return {
    safeMultiSend: new safeMultiSendConstructor(
      multiProvider,
      chain,
      safeAddress,
      safeSdk,
      safeService,
    ),
    createdTransactions,
    proposedTransactions,
    getNextNonceCalls: () => getNextNonceCalls,
  };
}

describe('SafeMultiSend', () => {
  afterEach(() => {
    delete SAFE_NONCE_OVERRIDES[chain];
  });

  it('uses queue-aware consecutive nonces for individual proposals', async () => {
    const { safeMultiSend, createdTransactions, getNextNonceCalls } =
      createSafeMultiSend({
        safeMultiSendAddress: safeAddress,
        nextNonce: '5',
      });

    const hashes = await safeMultiSend.sendTransactions(createCalls(3));

    expect(hashes).to.deep.equal(['hash-5', 'hash-6', 'hash-7']);
    expect(getNextNonceCalls()).to.equal(1);
    expect(createdTransactions.map((tx) => tx.nonce)).to.deep.equal([5, 6, 7]);
    expect(
      createdTransactions.map((tx) => tx.transactions.length),
    ).to.deep.equal([1, 1, 1]);
  });

  it('uses nonce overrides instead of the transaction service nonce', async () => {
    SAFE_NONCE_OVERRIDES[chain] = 9;
    const { safeMultiSend, createdTransactions, getNextNonceCalls } =
      createSafeMultiSend({
        safeMultiSendAddress: safeAddress,
        nextNonce: '5',
      });

    const hashes = await safeMultiSend.sendTransactions(createCalls(2));

    expect(hashes).to.deep.equal(['hash-9', 'hash-10']);
    expect(getNextNonceCalls()).to.equal(0);
    expect(createdTransactions.map((tx) => tx.nonce)).to.deep.equal([9, 10]);
  });

  it('uses a single queue-aware nonce for multisend proposals', async () => {
    const { safeMultiSend, createdTransactions, getNextNonceCalls } =
      createSafeMultiSend({
        safeMultiSendAddress: multiSendAddress,
        nextNonce: '5',
      });

    const hashes = await safeMultiSend.sendTransactions(createCalls(3));

    expect(hashes).to.deep.equal(['hash-5']);
    expect(getNextNonceCalls()).to.equal(1);
    expect(createdTransactions).to.have.lengthOf(1);
    expect(createdTransactions[0].nonce).to.equal(5);
    expect(createdTransactions[0].onlyCalls).to.equal(true);
    expect(createdTransactions[0].transactions).to.have.lengthOf(3);
  });
});
