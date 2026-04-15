import { expect } from 'chai';

import { ProviderType } from '@hyperlane-xyz/sdk';

import { submitAltVmTransferTx } from './transfer.js';

describe('submitAltVmTransferTx', () => {
  it('forwards Solana extraSigners through the CLI signer path', async () => {
    const signerCalls: unknown[] = [];
    const extraSigner = {
      publicKey: { toBase58: () => 'extra' },
      secretKey: new Uint8Array([1]),
    };
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

    await submitAltVmTransferTx({
      signer,
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
  });
});
