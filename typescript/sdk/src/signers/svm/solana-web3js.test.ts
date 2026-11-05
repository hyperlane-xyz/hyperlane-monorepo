import { expect } from 'chai';
import {
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  Connection,
} from '@solana/web3.js';
import sinon from 'sinon';
import {
  ProtocolType,
  TransactionSubmissionError,
  bufferToBase58,
} from '@hyperlane-xyz/utils';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ProviderType } from '../../providers/ProviderType.js';

import {
  KeypairSvmTransactionSigner,
  SvmMultiProtocolSignerAdapter,
} from './solana-web3js.js';

function serializedSignature(
  bytes: Parameters<Connection['sendRawTransaction']>[0],
): string {
  return bufferToBase58(
    Buffer.from(
      VersionedTransaction.deserialize(Uint8Array.from(bytes)).signatures[0],
    ),
  );
}

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
        else send.callsFake(async (bytes) => serializedSignature(bytes));
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
              enableBlockhashResubmit: lostBroadcastResponse
                ? false
                : undefined,
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

  for (const observed of [true, false]) {
    it(
      observed
        ? 'retains the local identity on a mismatching RPC signature'
        : 'preserves unobserved submission compatibility',
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
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 1,
        });
        const send = sinon
          .stub(connection, 'sendRawTransaction')
          .resolves('different-signature');
        sinon.stub(connection, 'getBlockHeight').resolves(0);
        const status = sinon.stub(connection, 'getSignatureStatus').resolves({
          context: { slot: 1 },
          value: {
            slot: 1,
            confirmations: null,
            confirmationStatus: 'finalized',
            err: null,
          },
        });
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
        const onSubmitted = sinon.spy();
        const result: unknown = await signer
          .sendAndConfirmTransaction(
            { type: ProviderType.SolanaWeb3, transaction: tx },
            observed ? { onSubmitted } : undefined,
          )
          .catch((error: unknown) => error);
        if (observed) {
          expect(result).to.be.instanceOf(TransactionSubmissionError);
          if (!(result instanceof TransactionSubmissionError)) throw result;
          expect(result.submissionState).to.equal('unknown');
          expect(result.txHash).to.equal(
            serializedSignature(send.firstCall.args[0]),
          );
          expect(onSubmitted.called).to.equal(false);
          expect(status.called).to.equal(false);
        } else {
          expect(result).to.equal('different-signature');
          expect(status.firstCall.args[0]).to.equal('different-signature');
        }
        expect(send.calledOnce).to.equal(true);
      },
    );
  }

  for (const explicitResubmit of [false, true]) {
    it(
      explicitResubmit
        ? 'rejects explicit re-signing with observers before signing or broadcasting'
        : 'checks a landed original signature without re-signing after expiry by default',
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
        const blockhash = sinon
          .stub(connection, 'getLatestBlockhash')
          .resolves({
            blockhash: Keypair.generate().publicKey.toBase58(),
            lastValidBlockHeight: 1,
          });
        const send = sinon
          .stub(connection, 'sendRawTransaction')
          .callsFake(async (bytes) => serializedSignature(bytes));
        const height = sinon.stub(connection, 'getBlockHeight').resolves(10000);
        const status = sinon.stub(connection, 'getSignatureStatus').resolves({
          context: { slot: 1 },
          value: {
            slot: 1,
            confirmations: null,
            confirmationStatus: 'finalized',
            err: null,
          },
        });
        const signer = new SvmMultiProtocolSignerAdapter(
          'solanamainnet',
          new KeypairSvmTransactionSigner(key.secretKey),
          provider,
          {
            enableBlockhashResubmit: true,
            maxConfirmationAttempts: 1,
            pollingDelayMs: 1,
          },
        );
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: key.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1,
          }),
        );
        const result: unknown = await signer
          .sendAndConfirmTransaction(
            { type: ProviderType.SolanaWeb3, transaction: tx },
            {
              onSubmitted: () => {},
              enableBlockhashResubmit: explicitResubmit ? true : undefined,
            },
          )
          .catch((error: unknown) => error);
        if (explicitResubmit) {
          expect(result).to.be.instanceOf(TransactionSubmissionError);
          if (!(result instanceof TransactionSubmissionError)) throw result;
          expect(result.submissionState).to.equal('not_submitted');
          expect(blockhash.called).to.equal(false);
          expect(send.called).to.equal(false);
        } else {
          expect(result).to.equal(await send.firstCall.returnValue);
          expect(send.callCount).to.equal(1);
          expect(status.firstCall.args[0]).to.equal(
            await send.firstCall.returnValue,
          );
        }
        expect(height.called).to.equal(false);
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
