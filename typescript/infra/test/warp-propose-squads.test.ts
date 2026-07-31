import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import bs58 from 'bs58';

import {
  assertAuthorizedByVault,
  collectSignerAuthorities,
  parseFilename,
  planReceiptProposals,
} from '../src/utils/warp-propose-squads.js';

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
        [
          {
            instructions: [ownerInstruction(VAULT)],
            waitForSlotAdvance: false,
          },
        ],
        VAULT,
      );
      expect(result.ok).to.be.true;
    });

    it('fails closed when an authority is a different vault', () => {
      const result = assertAuthorizedByVault(
        [
          {
            instructions: [ownerInstruction(FOREIGN)],
            waitForSlotAdvance: false,
          },
        ],
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
        [{ instructions: [noSignerIx], waitForSlotAdvance: false }],
        VAULT,
      );
      expect(result.ok).to.be.false;
    });
  });

  describe('planReceiptProposals', () => {
    it('rehydrates one plan per source tx, preserving boundaries and the barrier', () => {
      // Two instructions in tx0, one in tx1: proves each source tx keeps its own
      // instruction set rather than being flattened together.
      const tx0 = encodeV0Tx(VAULT, [
        ownerInstruction(VAULT),
        ownerInstruction(VAULT),
      ]);
      const tx1 = encodeV0Tx(VAULT, [ownerInstruction(VAULT)]);

      const plans = planReceiptProposals([
        {
          transaction_base58: tx0,
          waitForSlotAdvance: true,
        },
        { transaction_base58: tx1 },
      ]);

      expect(plans).to.have.lengthOf(2);
      expect(plans[0].waitForSlotAdvance).to.equal(true);
      expect(plans[0].instructions).to.have.lengthOf(2);
      expect(plans[1].waitForSlotAdvance).to.equal(false);
      expect(plans[1].instructions).to.have.lengthOf(1);
    });
  });
});
