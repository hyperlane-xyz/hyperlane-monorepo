import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import bs58 from 'bs58';

import {
  assertAuthorizedByVault,
  assertSimpleReceipt,
  collectSignerAuthorities,
  hasAddressTableLookups,
  parseFilename,
  planReceiptProposals,
} from '../src/utils/warp-propose-squads.js';

// u64 max marks an active (non-deactivated) address lookup table.
const ALT_ACTIVE_DEACTIVATION_SLOT = 2n ** 64n - 1n;

/**
 * Encode a v0 transaction whose readonly accounts are compressed into an
 * address-lookup table, so the serialized message carries addressTableLookups.
 */
function encodeV0TxWithAlt(): string {
  const readonlyAccounts = [
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
  ];
  const ix = new TransactionInstruction({
    programId: new PublicKey(PROGRAM),
    keys: [
      { pubkey: new PublicKey(VAULT), isSigner: true, isWritable: true },
      ...readonlyAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: false,
      })),
    ],
    data: Buffer.from([1]),
  });
  const lookupTable = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: ALT_ACTIVE_DEACTIVATION_SLOT,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: readonlyAccounts,
    },
  });
  const message = new TransactionMessage({
    payerKey: new PublicKey(VAULT),
    recentBlockhash: bs58.encode(new Uint8Array(32)),
    instructions: [ix],
  }).compileToV0Message([lookupTable]);
  return bs58.encode(new VersionedTransaction(message).serialize());
}

const VAULT = '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa';
const FOREIGN = 'BNGDJ1h9brgt6FFVd8No1TVAH48Fp44d7jkuydr1URwJ';
const PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const TOKEN_PDA = 'EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4';

function ownerInstruction(authority: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(PROGRAM),
    keys: [
      { pubkey: new PublicKey(TOKEN_PDA), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([1, 2, 3]),
  });
}

function encodeV0Tx(
  payer: string,
  instructions: TransactionInstruction[],
): string {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: bs58.encode(new Uint8Array(32)),
    instructions,
  }).compileToV0Message();
  return bs58.encode(new VersionedTransaction(message).serialize());
}

describe('warp-propose-squads', () => {
  describe('parseFilename', () => {
    it('parses the AltVMFileSubmitter naming', () => {
      const parsed = parseFilename(
        'solanamainnet-file-1700000000000-receipts.json',
      );
      expect('error' in parsed).to.be.false;
      if ('error' in parsed) {
        return;
      }
      expect(parsed.chain).to.equal('solanamainnet');
    });

    it('rejects an unrelated filename', () => {
      const parsed = parseFilename('combined-chainId1-receipts.json');
      expect('error' in parsed).to.be.true;
    });
  });

  describe('collectSignerAuthorities', () => {
    it('collects unique signer pubkeys across instructions', () => {
      const authorities = collectSignerAuthorities([
        ownerInstruction(VAULT),
        ownerInstruction(VAULT),
      ]);
      expect(authorities).to.have.members([VAULT]);
      expect(authorities).to.have.lengthOf(1);
    });
  });

  describe('assertAuthorizedByVault', () => {
    it('passes when every authority is the configured vault', () => {
      const result = assertAuthorizedByVault(
        [{ instructions: [ownerInstruction(VAULT)] }],
        VAULT,
      );
      expect(result.ok).to.be.true;
    });

    it('fails closed when an authority is a different vault', () => {
      const result = assertAuthorizedByVault(
        [{ instructions: [ownerInstruction(FOREIGN)] }],
        VAULT,
      );
      expect(result.ok).to.be.false;
      if (result.ok) {
        return;
      }
      expect(result.reason).to.contain(FOREIGN);
      expect(result.reason).to.contain(VAULT);
    });

    it('fails closed when there is no signer authority to verify', () => {
      const noSignerIx = new TransactionInstruction({
        programId: new PublicKey(PROGRAM),
        keys: [
          {
            pubkey: new PublicKey(TOKEN_PDA),
            isSigner: false,
            isWritable: true,
          },
        ],
        data: Buffer.from([9]),
      });
      const result = assertAuthorizedByVault(
        [{ instructions: [noSignerIx] }],
        VAULT,
      );
      expect(result.ok).to.be.false;
    });
  });

  describe('hasAddressTableLookups', () => {
    it('is false for a plain v0 transaction', () => {
      const tx = encodeV0Tx(VAULT, [ownerInstruction(VAULT)]);
      expect(hasAddressTableLookups(tx)).to.be.false;
    });

    it('is true for an ALT-compressed v0 transaction', () => {
      expect(hasAddressTableLookups(encodeV0TxWithAlt())).to.be.true;
    });
  });

  describe('assertSimpleReceipt', () => {
    const simpleTx = () => encodeV0Tx(VAULT, [ownerInstruction(VAULT)]);

    it('accepts a plain receipt (no barrier, default/absent compute, no ALT)', () => {
      const result = assertSimpleReceipt([
        { transaction_base58: simpleTx() },
        { transaction_base58: simpleTx(), computeUnits: 400_000 },
      ]);
      expect(result.ok).to.be.true;
    });

    it('fails closed on a slot-advance barrier receipt', () => {
      const result = assertSimpleReceipt([
        { transaction_base58: simpleTx(), waitForSlotAdvance: true },
      ]);
      expect(result.ok).to.be.false;
      if (result.ok) {
        return;
      }
      expect(result.reason).to.contain('waitForSlotAdvance');
    });

    it('fails closed on a non-default compute budget receipt', () => {
      const result = assertSimpleReceipt([
        { transaction_base58: simpleTx(), computeUnits: 1_400_000 },
      ]);
      expect(result.ok).to.be.false;
      if (result.ok) {
        return;
      }
      expect(result.reason).to.contain('1400000');
    });

    it('fails closed on an ALT-compressed receipt', () => {
      const result = assertSimpleReceipt([
        { transaction_base58: encodeV0TxWithAlt() },
      ]);
      expect(result.ok).to.be.false;
      if (result.ok) {
        return;
      }
      expect(result.reason).to.contain('lookup');
    });
  });

  describe('planReceiptProposals', () => {
    it('rehydrates one plan per source tx, preserving instruction boundaries', () => {
      // Two instructions in tx0, one in tx1: proves each source tx keeps its own
      // instruction set rather than being flattened together.
      const tx0 = encodeV0Tx(VAULT, [
        ownerInstruction(VAULT),
        ownerInstruction(VAULT),
      ]);
      const tx1 = encodeV0Tx(VAULT, [ownerInstruction(VAULT)]);

      const plans = planReceiptProposals([
        { transaction_base58: tx0 },
        { transaction_base58: tx1 },
      ]);

      expect(plans).to.have.lengthOf(2);
      expect(plans[0].instructions).to.have.lengthOf(2);
      expect(plans[1].instructions).to.have.lengthOf(1);
    });
  });
});
