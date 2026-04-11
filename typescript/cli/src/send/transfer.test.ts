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
    const context = {
      multiProvider: {
        getSolanaWeb3Provider: () => ({
          getTransaction: async () => ({ meta: { logMessages: [] } }),
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
  });
});
