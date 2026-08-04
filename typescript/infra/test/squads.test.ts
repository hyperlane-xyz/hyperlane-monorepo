import {
  AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { accounts } from '@sqds/multisig';
import { expect } from 'chai';
import sinon from 'sinon';

import {
  KeypairSvmTransactionSigner,
  MultiProtocolProvider,
  SvmMultiProtocolSignerAdapter,
  testSealevelChain,
} from '@hyperlane-xyz/sdk';

import { getSquadsKeys } from '../src/config/squads.js';
import {
  readAttachedTransactionIndexes,
  readCreatedTransactionIndex,
  submitReceiptTxsToSquads,
} from '../src/utils/squads.js';

const CHAIN = 'solanamainnet';

/**
 * Serialize a minimal on-chain `Multisig` account holding the given
 * `transactionIndex`, matching the shape `getNextSquadsTransactionIndex`
 * deserializes via `accounts.Multisig.fromAccountAddress`.
 */
function buildMultisigAccountInfo(
  programId: PublicKey,
  transactionIndex: number,
): AccountInfo<Buffer> {
  const multisig = accounts.Multisig.fromArgs({
    createKey: PublicKey.default,
    configAuthority: PublicKey.default,
    threshold: 1,
    timeLock: 0,
    transactionIndex,
    staleTransactionIndex: 0,
    rentCollector: null,
    bump: 255,
    members: [{ key: PublicKey.default, permissions: { mask: 7 } }],
  });
  const [data] = multisig.serialize();
  return {
    data,
    executable: false,
    lamports: 0,
    owner: programId,
    rentEpoch: 0,
  };
}

describe('squads', () => {
  describe('readCreatedTransactionIndex', () => {
    it('reads a bigint createdTransactionIndex attached to an error', () => {
      const error = Object.assign(new Error('boom'), {
        createdTransactionIndex: 42n,
      });
      expect(readCreatedTransactionIndex(error)).to.equal(42n);
    });

    it('returns undefined when the property is absent', () => {
      expect(readCreatedTransactionIndex(new Error('boom'))).to.be.undefined;
    });

    it('returns undefined when the property is not a bigint', () => {
      const error = Object.assign(new Error('boom'), {
        createdTransactionIndex: 42,
      });
      expect(readCreatedTransactionIndex(error)).to.be.undefined;
    });

    it('returns undefined for non-object inputs', () => {
      expect(readCreatedTransactionIndex('boom')).to.be.undefined;
      expect(readCreatedTransactionIndex(null)).to.be.undefined;
      expect(readCreatedTransactionIndex(undefined)).to.be.undefined;
    });
  });

  describe('readAttachedTransactionIndexes', () => {
    it('reads a bigint[] transactionIndexes attached to an error', () => {
      const error = Object.assign(new Error('boom'), {
        transactionIndexes: [1n, 2n, 3n],
      });
      expect(readAttachedTransactionIndexes(error)).to.deep.equal([1n, 2n, 3n]);
    });

    it('returns undefined when the property is absent', () => {
      expect(readAttachedTransactionIndexes(new Error('boom'))).to.be.undefined;
    });

    it('returns undefined when the array contains a non-bigint element', () => {
      const error = Object.assign(new Error('boom'), {
        transactionIndexes: [1n, 2],
      });
      expect(readAttachedTransactionIndexes(error)).to.be.undefined;
    });

    it('returns undefined for non-object inputs', () => {
      expect(readAttachedTransactionIndexes('boom')).to.be.undefined;
      expect(readAttachedTransactionIndexes(null)).to.be.undefined;
    });
  });

  describe('submitReceiptTxsToSquads', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('surfaces the created index of a proposal whose creation succeeded but approval failed (create-success/approve-failure regression)', async () => {
      const { programId, vault } = getSquadsKeys(CHAIN);

      const mpp = new MultiProtocolProvider({
        [CHAIN]: { ...testSealevelChain, name: CHAIN },
      });

      // `buildSquadsVaultTransactionProposal` reads the multisig's
      // `transactionIndex` via `Connection.getAccountInfo` twice per call
      // (index derivation, then an owner sanity check) — two proposals means
      // four calls. First proposal reports transactionIndex=5 (next=6);
      // second reports transactionIndex=6 (next=7).
      const accountInfoStub = sandbox.stub(
        Connection.prototype,
        'getAccountInfo',
      );
      accountInfoStub
        .onCall(0)
        .resolves(buildMultisigAccountInfo(programId, 5));
      accountInfoStub
        .onCall(1)
        .resolves(buildMultisigAccountInfo(programId, 5));
      accountInfoStub
        .onCall(2)
        .resolves(buildMultisigAccountInfo(programId, 6));
      accountInfoStub
        .onCall(3)
        .resolves(buildMultisigAccountInfo(programId, 6));

      sandbox.stub(Connection.prototype, 'getLatestBlockhash').resolves({
        blockhash: '11111111111111111111111111111111111111111',
        lastValidBlockHeight: 100,
      });

      // First proposal: create + approve both succeed (index 6). Second
      // proposal: create succeeds (index 7), approve fails — this is the
      // create-success/approve-failure path from `createAndApproveSquadsProposal`.
      const buildAndSendStub = sandbox.stub(
        SvmMultiProtocolSignerAdapter.prototype,
        'buildAndSendTransaction',
      );
      buildAndSendStub.onCall(0).resolves('sig-create-1');
      buildAndSendStub.onCall(1).resolves('sig-approve-1');
      buildAndSendStub.onCall(2).resolves('sig-create-2');
      buildAndSendStub.onCall(3).rejects(new Error('approve rpc failed'));

      const signer = new KeypairSvmTransactionSigner(
        Keypair.generate().secretKey,
      );
      const signerAdapter = new SvmMultiProtocolSignerAdapter(
        CHAIN,
        signer,
        mpp,
      );

      const arbitraryIx = new TransactionInstruction({
        programId,
        keys: [{ pubkey: vault, isSigner: false, isWritable: true }],
        data: Buffer.from([1]),
      });

      let thrown: unknown;
      try {
        await submitReceiptTxsToSquads(
          CHAIN,
          [{ instructions: [arbitraryIx] }, { instructions: [arbitraryIx] }],
          mpp,
          signerAdapter,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.be.instanceOf(Error);

      // The error thrown by `createAndApproveSquadsProposal` for the second
      // (approve-failed) proposal still carries its confirmed creation
      // index...
      expect(readCreatedTransactionIndex(thrown)).to.equal(7n);
      // ...and `submitReceiptTxsToSquads` absorbed it into the accumulated
      // indexes attached to its own re-thrown error, alongside the fully
      // succeeded first proposal. A rerun without this fix would silently
      // drop index 7 and duplicate it.
      expect(readAttachedTransactionIndexes(thrown)).to.deep.equal([6n, 7n]);
    });
  });
});
