import { expect } from 'chai';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';

import { KeypairSvmTransactionSigner } from './solana-web3js.js';

describe('KeypairSvmTransactionSigner', () => {
  it('preserves existing partialSign signatures when signing with main keypair', async () => {
    const mainSigner = Keypair.generate();
    const extraSigner = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = new Transaction();
    // Two transfers so both mainSigner and extraSigner are required signers
    tx.add(
      SystemProgram.transfer({
        fromPubkey: mainSigner.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 1000,
      }),
    );
    tx.add(
      SystemProgram.transfer({
        fromPubkey: extraSigner.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 500,
      }),
    );
    tx.feePayer = mainSigner.publicKey;
    tx.recentBlockhash = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

    // Extra signer signs first
    tx.partialSign(extraSigner);
    const extraSigBefore = tx.signatures.find((s) =>
      s.publicKey.equals(extraSigner.publicKey),
    );
    expect(extraSigBefore?.signature).to.not.be.null;

    // Main signer signs via KeypairSvmTransactionSigner — should PRESERVE extra signer's signature
    const signer = new KeypairSvmTransactionSigner(mainSigner.secretKey);
    await signer.signTransaction(tx);

    const mainSig = tx.signatures.find((s) =>
      s.publicKey.equals(mainSigner.publicKey),
    );
    const extraSigAfter = tx.signatures.find((s) =>
      s.publicKey.equals(extraSigner.publicKey),
    );
    expect(mainSig?.signature).to.not.be.null;
    expect(extraSigAfter?.signature).to.not.be.null;
  });

  it('REGRESSION: sign() wipes extra signatures (demonstrates the bug we fixed)', () => {
    const mainSigner = Keypair.generate();
    const extraSigner = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = new Transaction();
    // Two transfers so both mainSigner and extraSigner are required signers
    tx.add(
      SystemProgram.transfer({
        fromPubkey: mainSigner.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 1000,
      }),
    );
    tx.add(
      SystemProgram.transfer({
        fromPubkey: extraSigner.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 500,
      }),
    );
    tx.feePayer = mainSigner.publicKey;
    tx.recentBlockhash = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

    tx.partialSign(extraSigner);
    // sign() clears all signatures — this is the bug we fixed
    tx.sign(mainSigner);

    const extraSig = tx.signatures.find((s) =>
      s.publicKey.equals(extraSigner.publicKey),
    );
    // After sign(), the extra signer's signature is GONE (null)
    expect(extraSig?.signature).to.be.null;
  });
});
