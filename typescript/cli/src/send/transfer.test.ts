import { expect } from 'chai';

import { ProviderType } from '@hyperlane-xyz/sdk';

import { fetchSealevelReceiptWithLogs } from './transfer.js';

describe('fetchSealevelReceiptWithLogs', () => {
  it('polls until Solana transaction logs are available', async () => {
    const calls: string[] = [];
    const receipt = {
      meta: { logMessages: ['Dispatched message to 1234, ID deadbeef'] },
    };
    const context = {
      multiProvider: {
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
    let calls = 0;
    const context = {
      multiProvider: {
        getSolanaWeb3Provider: () => ({
          getTransaction: async () => {
            calls += 1;
            return { meta: { logMessages: [] } };
          },
        }),
      },
    } as any;

    await expect(
      fetchSealevelReceiptWithLogs(
        context,
        'solanamainnet',
        'missing-logs-signature',
        0,
        2,
      ),
    ).to.be.rejectedWith(
      'Transaction logs unavailable for Solana transaction missing-logs-signature',
    );
    expect(calls).to.equal(2);
  });

  it('retries through transient getTransaction errors', async () => {
    let calls = 0;
    const receipt = {
      meta: { logMessages: ['Dispatched message to 1234, ID deadbeef'] },
    };
    const context = {
      multiProvider: {
        getSolanaWeb3Provider: () => ({
          getTransaction: async () => {
            calls += 1;
            if (calls === 1) throw new Error('temporary rpc failure');
            return receipt;
          },
        }),
      },
    } as any;

    const typedReceipt = await fetchSealevelReceiptWithLogs(
      context,
      'solanamainnet',
      'transient-signature',
      0,
      2,
    );

    expect(calls).to.equal(2);
    expect(typedReceipt).to.deep.equal({
      type: ProviderType.SolanaWeb3,
      receipt,
    });
  });
});
