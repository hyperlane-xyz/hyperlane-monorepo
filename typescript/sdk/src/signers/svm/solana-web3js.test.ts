import { expect } from 'chai';
import {
  Keypair,
  SystemProgram,
  Transaction,
  Connection,
} from '@solana/web3.js';
import sinon from 'sinon';
import { ProtocolType, TransactionSubmissionError } from '@hyperlane-xyz/utils';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ProviderType } from '../../providers/ProviderType.js';

import {
  KeypairSvmTransactionSigner,
  SvmMultiProtocolSignerAdapter,
} from './solana-web3js.js';

describe('SVM submission tracking', () => {
  afterEach(() => sinon.restore());

  for (const lostBroadcastResponse of [true, false]) {
    it(
      lostBroadcastResponse
        ? 'preserves the signed identity on a lost broadcast response'
        : 'does not re-sign an ambiguous transaction after blockhash expiry',
      async () => {
        const key = Keypair.generate();
        const connection = new Connection('https://solana.example.invalid');
        const provider = new MultiProtocolProvider({
          solanamainnet: {
            name: 'solanamainnet',
            protocol: ProtocolType.Sealevel,
            chainId: 1399811149,
            domainId: 1399811149,
            rpcUrls: [{ http: 'https://solana.example.invalid' }],
          },
        });
        provider.setProvider('solanamainnet', {
          type: ProviderType.SolanaWeb3,
          provider: connection,
        });
        sinon.stub(connection, 'getLatestBlockhash').resolves({
          blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
          lastValidBlockHeight: 1,
        });
        const send = sinon.stub(connection, 'sendRawTransaction');
        if (lostBroadcastResponse)
          send.rejects(new Error('broadcast response lost'));
        else send.resolves('acknowledged-signature');
        const height = sinon.stub(connection, 'getBlockHeight').resolves(10000);
        sinon
          .stub(connection, 'getSignatureStatus')
          .resolves({ context: { slot: 1 }, value: null });
        const signer = new SvmMultiProtocolSignerAdapter(
          'solanamainnet',
          new KeypairSvmTransactionSigner(key.secretKey),
          provider,
          { maxConfirmationAttempts: 1, pollingDelayMs: 1 },
        );
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: key.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1,
          }),
        );
        tx.feePayer = key.publicKey;
        let attemptedHash: string | undefined;
        let submittedHash: string | undefined;
        try {
          await signer.sendAndConfirmTransaction(
            { type: ProviderType.SolanaWeb3, transaction: tx },
            {
              enableBlockhashResubmit: false,
              onSubmissionAttempt: (hash) => {
                attemptedHash = hash;
              },
              onSubmitted: (hash) => {
                submittedHash = hash;
              },
            },
          );
          expect.fail('Expected an unresolved submission');
        } catch (error) {
          expect(error).to.be.instanceOf(TransactionSubmissionError);
          if (!(error instanceof TransactionSubmissionError)) throw error;
          expect(attemptedHash).to.be.a('string').and.not.empty;
          expect(error.txHash).to.equal(
            lostBroadcastResponse ? attemptedHash : submittedHash,
          );
          expect(error.submissionState).to.equal(
            lostBroadcastResponse ? 'unknown' : 'submitted',
          );
        }
        expect(send.callCount).to.equal(1);
        expect(height.callCount).to.equal(0);
      },
    );
  }
});

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
