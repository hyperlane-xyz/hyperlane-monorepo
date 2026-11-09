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
import {
  ProviderType,
  type SolanaWeb3Transaction,
} from '../../providers/ProviderType.js';

import {
  KeypairSvmTransactionSigner,
  SvmMultiProtocolSignerAdapter,
  type SvmSignerConfig,
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

  function harness(config: SvmSignerConfig = {}) {
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
    const blockhash = sinon.stub(connection, 'getLatestBlockhash').resolves({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
    const send = sinon
      .stub(connection, 'sendRawTransaction')
      .callsFake(async (bytes) => serializedSignature(bytes));
    const height = sinon.stub(connection, 'getBlockHeight').resolves(10000);
    const status = sinon
      .stub(connection, 'getSignatureStatus')
      .resolves({ context: { slot: 10000 }, value: null });
    const keySigner = new KeypairSvmTransactionSigner(key.secretKey);
    const sign = sinon.spy(keySigner, 'signTransaction');
    const adapter = new SvmMultiProtocolSignerAdapter(
      'solanamainnet',
      keySigner,
      provider,
      {
        maxConfirmationAttempts: 3,
        pollingDelayMs: 1,
        ...config,
      },
    );
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: key.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    const tx: SolanaWeb3Transaction = {
      type: ProviderType.SolanaWeb3,
      transaction,
    };
    return { adapter, tx, sign, send, status, blockhash, height };
  }

  async function failure(
    operation: Promise<unknown>,
  ): Promise<TransactionSubmissionError> {
    try {
      await operation;
    } catch (error) {
      expect(error).to.be.instanceOf(TransactionSubmissionError);
      if (error instanceof TransactionSubmissionError) return error;
      throw error;
    }
    throw new Error('Expected submission failure');
  }

  for (const observed of [false, true]) {
    for (const lostResponse of [false, true]) {
      it(`keeps one identity with observed=${observed}, lost response=${lostResponse}`, async () => {
        const h = harness();
        if (lostResponse) h.send.rejects(new Error('broadcast response lost'));
        const onSubmitted = sinon.spy();
        const error = await failure(
          h.adapter.sendAndConfirmTransaction(
            h.tx,
            observed ? { onSubmitted } : undefined,
          ),
        );
        expect(error.submissionState).to.equal(
          lostResponse ? 'unknown' : 'submitted',
        );
        const signature = serializedSignature(h.send.firstCall.args[0]);
        expect(error.txHash).to.equal(signature);
        expect(h.sign.calledOnce).to.equal(true);
        expect(h.send.calledOnce).to.equal(true);
        expect(h.blockhash.calledOnce).to.equal(true);
        expect(h.height.called).to.equal(false);
        expect(
          h.status.getCalls().every((call) => call.args[0] === signature),
        ).to.equal(true);
      });
    }

    it(`preserves the signed identity on a mismatching RPC response, observed=${observed}`, async () => {
      const h = harness();
      h.send.resolves('different-signature');
      const onSubmitted = sinon.spy();
      const error = await failure(
        h.adapter.sendAndConfirmTransaction(
          h.tx,
          observed ? { onSubmitted } : undefined,
        ),
      );
      expect(error.submissionState).to.equal('unknown');
      expect(error.txHash).to.equal(
        serializedSignature(h.send.firstCall.args[0]),
      );
      expect(h.status.called).to.equal(false);
      expect(onSubmitted.called).to.equal(false);
    });
  }

  for (const configResubmit of [false, true]) {
    it(`rejects effective true before signing (adapter=${configResubmit})`, async () => {
      const h = harness({ enableBlockhashResubmit: configResubmit });
      const error = await failure(
        h.adapter.sendAndConfirmTransaction(
          h.tx,
          configResubmit ? undefined : { enableBlockhashResubmit: true },
        ),
      );
      expect(error.submissionState).to.equal('not_submitted');
      expect(error.message).to.include('resubmission is unsupported');
      expect(h.blockhash.called).to.equal(false);
      expect(h.sign.called).to.equal(false);
      expect(h.send.called).to.equal(false);
    });
  }

  it('allows false to override a legacy true config and returns an already landed signature', async () => {
    const h = harness({ enableBlockhashResubmit: true });
    h.status.resolves({
      context: { slot: 10000 },
      value: {
        slot: 1,
        confirmations: null,
        confirmationStatus: 'finalized',
        err: null,
      },
    });
    const result = await h.adapter.sendAndConfirmTransaction(h.tx, {
      enableBlockhashResubmit: false,
    });
    expect(result).to.equal(serializedSignature(h.send.firstCall.args[0]));
    expect(h.status.firstCall.args[0]).to.equal(result);
    expect(h.sign.calledOnce).to.equal(true);
    expect(h.send.calledOnce).to.equal(true);
    expect(h.height.called).to.equal(false);
  });

  it('keeps polling the original through a stale null result, RPC error and eventual finality', async () => {
    const h = harness({ commitment: 'finalized' });
    h.status.onFirstCall().resolves({ context: { slot: 1 }, value: null });
    h.status.onSecondCall().rejects(new Error('RPC unavailable'));
    h.status.onThirdCall().resolves({
      context: { slot: 10000 },
      value: {
        slot: 1,
        confirmations: null,
        confirmationStatus: 'finalized',
        err: null,
      },
    });
    const result = await h.adapter.sendAndConfirmTransaction(h.tx);
    expect(
      h.status.getCalls().every((call) => call.args[0] === result),
    ).to.equal(true);
    expect(h.send.calledOnce).to.equal(true);
    expect(h.blockhash.calledOnce).to.equal(true);
  });

  it('retains the original while a landed transaction has not reached requested finality', async () => {
    const h = harness({ commitment: 'finalized', maxConfirmationAttempts: 1 });
    h.status.resolves({
      context: { slot: 10000 },
      value: {
        slot: 1,
        confirmations: 1,
        confirmationStatus: 'confirmed',
        err: null,
      },
    });
    const error = await failure(h.adapter.sendAndConfirmTransaction(h.tx));
    expect(error.submissionState).to.equal('submitted');
    expect(error.txHash).to.equal(
      serializedSignature(h.send.firstCall.args[0]),
    );
    expect(h.send.calledOnce).to.equal(true);
  });
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
