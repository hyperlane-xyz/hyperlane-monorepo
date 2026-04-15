import { expect } from 'chai';

import { ProviderType } from '@hyperlane-xyz/sdk';

import {
  fetchSealevelReceiptWithLogs,
  submitAltVmTransferTx,
} from './transfer.js';

describe('fetchSealevelReceiptWithLogs', () => {
  it('polls until Solana transaction logs are available', async () => {
    const calls: string[] = [];
    const receipt = {
      meta: { logMessages: ['Dispatched message to 1234, ID deadbeef'] },
    };
    const context = {
      multiProtocolProvider: {
        getSolanaWeb3Provider: () => ({
          getTransaction: async (signature: string) => {
            calls.push(signature);
            return calls.length === 1 ? null : receipt;
          },
        }),
      },
    } as any;

    const typedReceipt = await fetchSealevelReceiptWithLogs(
      context,
      'solanamainnet',
      'test-signature',
      0,
      2,
    );

    expect(calls).to.deep.equal(['test-signature', 'test-signature']);
    expect(typedReceipt).to.deep.equal({
      type: ProviderType.SolanaWeb3,
      receipt,
    });
  });

  it('throws when Solana logs never become available', async () => {
    const context = {
      multiProtocolProvider: {
        getSolanaWeb3Provider: () => ({
          getTransaction: async () => ({ meta: { logMessages: [] } }),
        }),
      },
    } as any;

    try {
      await fetchSealevelReceiptWithLogs(
        context,
        'solanamainnet',
        'missing-logs-signature',
        0,
        2,
      );
      throw new Error('expected fetchSealevelReceiptWithLogs to throw');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal(
        'Transaction logs unavailable for Solana transaction missing-logs-signature',
      );
    }
  });
});

describe('submitAltVmTransferTx', () => {
  it('forwards Solana extraSigners through the CLI signer path', async () => {
    const signerCalls: unknown[] = [];
    const extraSigner = {
      publicKey: { toBase58: () => 'extra' },
      secretKey: new Uint8Array([1]),
    };
    const receipt = {
      meta: { logMessages: ['Dispatched message to 1234, ID deadbeef'] },
    };
    const context = {
      multiProtocolProvider: {
        getSolanaWeb3Provider: () => ({
          getTransaction: async () => receipt,
        }),
      },
    } as any;
    const signer = {
      sendAndConfirmTransaction: async (transaction: unknown) => {
        signerCalls.push(transaction);
        return { signature: 'solana-signature' };
      },
    };
    const transaction = {
      instructions: [
        {
          programId: { toBase58: () => 'program' },
          keys: [],
          data: new Uint8Array([1]),
        },
      ],
    };

    const typedReceipt = await submitAltVmTransferTx({
      context,
      signer,
      origin: 'solanamainnet',
      tx: {
        type: ProviderType.SolanaWeb3,
        transaction,
        extraSigners: [extraSigner],
      },
    });

    expect(signerCalls).to.deep.equal([
      {
        ...transaction,
        extraSigners: [extraSigner],
      },
    ]);
    expect(typedReceipt).to.deep.equal({
      type: ProviderType.SolanaWeb3,
      receipt,
    });
  });
});
