import { AccountRole } from '@solana/kit';
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  RpcResponseAndContext,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import bs58 from 'bs58';

import { assert } from '@hyperlane-xyz/utils';

import {
  type PrintableSvmInstruction,
  assertAuthorizedByVault,
  assertSimpleReceipt,
  collectSignerAuthorities,
  parseFilename,
  planReceiptProposals,
  resolveWireAddressLookupTables,
} from '../src/utils/warp-propose-squads.js';

// u64 max marks an active (non-deactivated) address lookup table.
const ALT_ACTIVE_DEACTIVATION_SLOT = 2n ** 64n - 1n;

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

/**
 * Instruction with three readonly non-signer accounts, so it has something to
 * compress into an address-lookup table in `encodeV0TxWithAlt`.
 */
function altOwnerInstruction(): TransactionInstruction {
  const readonlyAccounts = [
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
  ];
  return new TransactionInstruction({
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

/**
 * Encode a legacy (non-versioned) transaction message. `VersionedMessage.deserialize`
 * (used internally by `VersionedTransaction.deserialize`) inspects the leading
 * version-prefix byte: a legacy message's high bit is unset, so it comes back
 * as a plain `Message`, not `MessageV0` — exercising the non-v0 rejection
 * branch in `resolveWireAddressLookupTables` /
 * `validateInstructionsAgainstWire`, both of which only support the v0
 * messages the writer actually emits.
 */
function encodeLegacyTx(
  payer: string,
  instructions: TransactionInstruction[],
): string {
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: bs58.encode(new Uint8Array(32)),
    instructions,
  }).compileToLegacyMessage();
  return bs58.encode(new VersionedTransaction(message).serialize());
}

/**
 * Encode a v0 transaction whose readonly (non-signer) accounts are
 * compressed into an address-lookup table, so the serialized message carries
 * addressTableLookups. Takes the same instructions used to build the wire so
 * callers can derive matching expanded `instructions[]` from them. Returns
 * both the wire and the `AddressLookupTableAccount` used to compress it, so
 * tests can pass the resolved table into `planReceiptProposals` /
 * `validateInstructionsAgainstWire` the same way the propose script resolves
 * it from RPC.
 */
function encodeV0TxWithAlt(
  payer: string,
  instructions: TransactionInstruction[],
): { transactionBase58: string; lookupTable: AddressLookupTableAccount } {
  const lookupAddresses = instructions.flatMap((ix) =>
    ix.keys.filter((key) => !key.isSigner).map((key) => key.pubkey),
  );
  const lookupTable = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: ALT_ACTIVE_DEACTIVATION_SLOT,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: lookupAddresses,
    },
  });
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: bs58.encode(new Uint8Array(32)),
    instructions,
  }).compileToV0Message([lookupTable]);
  return {
    transactionBase58: bs58.encode(
      new VersionedTransaction(message).serialize(),
    ),
    lookupTable,
  };
}

/**
 * Derive the expanded `instructions[]` shape a writer would emit
 * (svm-sdk's `SvmSigner.transactionToPrintableJson`) from the SAME
 * `TransactionInstruction[]` used to build a test's wire payload.
 */
function printableInstructionsFrom(
  instructions: TransactionInstruction[],
): PrintableSvmInstruction[] {
  return instructions.map((ix) => ({
    programAddress: ix.programId.toBase58(),
    accounts: ix.keys.map((key) => ({
      address: key.pubkey.toBase58(),
      role: key.isSigner
        ? key.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : key.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: ix.data.toString('hex'),
  }));
}

function keySummary(ix: TransactionInstruction) {
  return ix.keys.map((key) => ({
    address: key.pubkey.toBase58(),
    isSigner: key.isSigner,
    isWritable: key.isWritable,
  }));
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

  describe('assertSimpleReceipt', () => {
    const simpleIx = () => ownerInstruction(VAULT);

    it('accepts a plain receipt (no barrier, default/absent compute, no ALT)', () => {
      const ix = simpleIx();
      const result = assertSimpleReceipt([
        {
          transaction_base58: encodeV0Tx(VAULT, [ix]),
          instructions: printableInstructionsFrom([ix]),
        },
        {
          transaction_base58: encodeV0Tx(VAULT, [ix]),
          instructions: printableInstructionsFrom([ix]),
          computeUnits: 400_000,
        },
      ]);
      expect(result.ok).to.be.true;
    });

    it('fails closed on a slot-advance barrier receipt', () => {
      const ix = simpleIx();
      const result = assertSimpleReceipt([
        {
          transaction_base58: encodeV0Tx(VAULT, [ix]),
          instructions: printableInstructionsFrom([ix]),
          waitForSlotAdvance: true,
        },
      ]);
      expect(result.ok).to.be.false;
      if (result.ok) {
        return;
      }
      expect(result.reason).to.contain('waitForSlotAdvance');
    });

    it('does not reject a non-default compute budget receipt (carried through instead)', () => {
      const ix = simpleIx();
      const result = assertSimpleReceipt([
        {
          transaction_base58: encodeV0Tx(VAULT, [ix]),
          instructions: printableInstructionsFrom([ix]),
          computeUnits: 1_400_000,
        },
      ]);
      expect(result.ok).to.be.true;
    });

    it('does not reject an ALT-compressed receipt (rehydrated from expanded instructions)', () => {
      const ix = altOwnerInstruction();
      const { transactionBase58 } = encodeV0TxWithAlt(VAULT, [ix]);
      const result = assertSimpleReceipt([
        {
          transaction_base58: transactionBase58,
          instructions: printableInstructionsFrom([ix]),
        },
      ]);
      expect(result.ok).to.be.true;
    });
  });

  describe('planReceiptProposals', () => {
    it('rehydrates one plan per source tx, preserving instruction boundaries', () => {
      // Two instructions in tx0, one in tx1: proves each source tx keeps its own
      // instruction set rather than being flattened together.
      const tx0Ixs = [ownerInstruction(VAULT), ownerInstruction(VAULT)];
      const tx1Ixs = [ownerInstruction(VAULT)];

      const plans = planReceiptProposals(
        [
          {
            transaction_base58: encodeV0Tx(VAULT, tx0Ixs),
            instructions: printableInstructionsFrom(tx0Ixs),
          },
          {
            transaction_base58: encodeV0Tx(VAULT, tx1Ixs),
            instructions: printableInstructionsFrom(tx1Ixs),
          },
        ],
        [[], []],
      );

      expect(plans).to.have.lengthOf(2);
      expect(plans[0].instructions).to.have.lengthOf(2);
      expect(plans[1].instructions).to.have.lengthOf(1);
    });

    it('throws when altAccountsPerTx length does not match txs length', () => {
      const tx0Ixs = [ownerInstruction(VAULT)];
      const tx1Ixs = [ownerInstruction(VAULT)];

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: encodeV0Tx(VAULT, tx0Ixs),
              instructions: printableInstructionsFrom(tx0Ixs),
            },
            {
              transaction_base58: encodeV0Tx(VAULT, tx1Ixs),
              instructions: printableInstructionsFrom(tx1Ixs),
            },
          ],
          [[]],
        ),
      ).to.throw('does not match txs length');
    });

    it('rejects a non-v0 (legacy) transaction message', () => {
      const ix = ownerInstruction(VAULT);

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: encodeLegacyTx(VAULT, [ix]),
              instructions: printableInstructionsFrom([ix]),
            },
          ],
          [[]],
        ),
      ).to.throw('Expected a v0 transaction message');
    });

    it('rehydrates an ALT-compressed receipt from its expanded instructions and carries computeUnits', () => {
      const ix = altOwnerInstruction();
      const { transactionBase58, lookupTable } = encodeV0TxWithAlt(VAULT, [ix]);
      const plans = planReceiptProposals(
        [
          {
            transaction_base58: transactionBase58,
            instructions: printableInstructionsFrom([ix]),
            computeUnits: 1_400_000,
          },
        ],
        [[lookupTable]],
      );

      expect(plans).to.have.lengthOf(1);
      expect(plans[0].computeUnits).to.equal(1_400_000);
      expect(plans[0].instructions).to.have.lengthOf(1);
      const rehydrated = plans[0].instructions[0];
      expect(rehydrated.programId.toBase58()).to.equal(PROGRAM);
      expect(keySummary(rehydrated)).to.deep.equal(keySummary(ix));
    });

    it('throws when an ALT-loaded account address is swapped to a foreign key (ALT identity tamper)', () => {
      // altOwnerInstruction accounts: [VAULT (signer, static), 3 readonly
      // accounts compressed into the ALT]. The wire and the resolved lookup
      // table stay byte-identical to a legitimate receipt; only the second
      // ALT-loaded account's address is swapped in the expanded
      // instructions[], mirroring an attacker rewriting an ALT-loaded account
      // identity that used to be unverifiable offline.
      const ix = altOwnerInstruction();
      const { transactionBase58, lookupTable } = encodeV0TxWithAlt(VAULT, [ix]);
      const printableIxs = printableInstructionsFrom([ix]);
      const wireAccounts = printableIxs[0].accounts;
      assert(wireAccounts, 'expected accounts on fixture instruction');
      const tampered: PrintableSvmInstruction[] = [
        {
          programAddress: printableIxs[0].programAddress,
          accounts: [
            wireAccounts[0],
            { address: FOREIGN, role: wireAccounts[1].role },
            wireAccounts[2],
            wireAccounts[3],
          ],
          data: printableIxs[0].data,
        },
      ];

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: transactionBase58,
              instructions: tampered,
            },
          ],
          [[lookupTable]],
        ),
      ).to.throw('Receipt instructions do not match wire payload');
    });

    it('fails closed when altAccountsPerTx omits a table the wire references (missing-table fail-closed)', () => {
      const ix = altOwnerInstruction();
      const { transactionBase58 } = encodeV0TxWithAlt(VAULT, [ix]);

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: transactionBase58,
              instructions: printableInstructionsFrom([ix]),
            },
          ],
          [[]],
        ),
      ).to.throw('Failed to find address lookup table account for table key');
    });

    it('carries a max-compute-budget receipt (e.g. program upgrade) through as computeUnits', () => {
      const ix = ownerInstruction(VAULT);
      const plans = planReceiptProposals(
        [
          {
            transaction_base58: encodeV0Tx(VAULT, [ix]),
            instructions: printableInstructionsFrom([ix]),
            computeUnits: 1_400_000,
          },
        ],
        [[]],
      );

      expect(plans).to.have.lengthOf(1);
      expect(plans[0].computeUnits).to.equal(1_400_000);
    });

    it('throws when the expanded instructions do not match the wire payload (programAddress tamper)', () => {
      const ix = ownerInstruction(VAULT);
      const printableIxs = printableInstructionsFrom([ix]);
      const tampered: PrintableSvmInstruction[] = [
        {
          programAddress: TOKEN_PDA,
          accounts: printableIxs[0].accounts,
          data: printableIxs[0].data,
        },
      ];

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: encodeV0Tx(VAULT, [ix]),
              instructions: tampered,
            },
          ],
          [[]],
        ),
      ).to.throw('Receipt instructions do not match wire payload');
    });

    it('throws when the expanded instructions do not match the wire payload (data tamper)', () => {
      const ix = ownerInstruction(VAULT);
      const printableIxs = printableInstructionsFrom([ix]);
      const tampered: PrintableSvmInstruction[] = [
        {
          programAddress: printableIxs[0].programAddress,
          accounts: printableIxs[0].accounts,
          data: 'ff',
        },
      ];

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: encodeV0Tx(VAULT, [ix]),
              instructions: tampered,
            },
          ],
          [[]],
        ),
      ).to.throw('Receipt instructions do not match wire payload');
    });

    it('throws when an account address is swapped to a foreign key (account substitution attack)', () => {
      // ownerInstruction accounts: [TOKEN_PDA (writable), authority (signer)].
      // The wire (transaction_base58) and the instruction's programAddress/data
      // stay byte-identical to a legitimate receipt; only the signer account's
      // address is swapped, mirroring an attacker rewriting the authority the
      // proposed vault transaction will target.
      const ix = ownerInstruction(VAULT);
      const printableIxs = printableInstructionsFrom([ix]);
      const wireAccounts = printableIxs[0].accounts;
      assert(wireAccounts, 'expected accounts on fixture instruction');
      const tampered: PrintableSvmInstruction[] = [
        {
          programAddress: printableIxs[0].programAddress,
          accounts: [
            wireAccounts[0],
            { address: FOREIGN, role: wireAccounts[1].role },
          ],
          data: printableIxs[0].data,
        },
      ];

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: encodeV0Tx(VAULT, [ix]),
              instructions: tampered,
            },
          ],
          [[]],
        ),
      ).to.throw('Receipt instructions do not match wire payload');
    });

    it('throws when an account claims a role stronger than the wire grants (role escalation attack)', () => {
      // Third account is genuinely readonly + non-signer in the wire: it is
      // neither the fee payer (VAULT) nor referenced elsewhere as writable, so
      // there is no legitimate reason for the receipt to claim it writable.
      const readonlyAccount = Keypair.generate().publicKey;
      const ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM),
        keys: [
          {
            pubkey: new PublicKey(TOKEN_PDA),
            isSigner: false,
            isWritable: true,
          },
          { pubkey: new PublicKey(VAULT), isSigner: true, isWritable: false },
          { pubkey: readonlyAccount, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([4, 5, 6]),
      });
      const printableIxs = printableInstructionsFrom([ix]);
      const wireAccounts = printableIxs[0].accounts;
      assert(wireAccounts, 'expected accounts on fixture instruction');
      const tampered: PrintableSvmInstruction[] = [
        {
          programAddress: printableIxs[0].programAddress,
          accounts: [
            wireAccounts[0],
            wireAccounts[1],
            { address: wireAccounts[2].address, role: AccountRole.WRITABLE },
          ],
          data: printableIxs[0].data,
        },
      ];

      expect(() =>
        planReceiptProposals(
          [
            {
              transaction_base58: encodeV0Tx(VAULT, [ix]),
              instructions: tampered,
            },
          ],
          [[]],
        ),
      ).to.throw('Receipt instructions do not match wire payload');
    });
  });

  describe('resolveWireAddressLookupTables', () => {
    // Minimal stub satisfying only the method resolveWireAddressLookupTables
    // uses, so tests never need `as any`/`as Connection` to construct one.
    function mockConnection(
      known: AddressLookupTableAccount,
    ): Pick<Connection, 'getAddressLookupTable'> {
      return {
        async getAddressLookupTable(
          accountKey: PublicKey,
        ): Promise<RpcResponseAndContext<AddressLookupTableAccount | null>> {
          const value = accountKey.equals(known.key) ? known : null;
          return { context: { slot: 0 }, value };
        },
      };
    }

    it('resolves every ALT referenced by the wire from the connection', async () => {
      const ix = altOwnerInstruction();
      const { transactionBase58, lookupTable } = encodeV0TxWithAlt(VAULT, [ix]);

      const resolved = await resolveWireAddressLookupTables(
        transactionBase58,
        mockConnection(lookupTable),
      );

      expect(resolved).to.have.lengthOf(1);
      expect(resolved[0].key.equals(lookupTable.key)).to.be.true;
    });

    it('returns an empty array for a wire with no ALT lookups', async () => {
      const ix = ownerInstruction(VAULT);
      const unusedLookupTable = new AddressLookupTableAccount({
        key: Keypair.generate().publicKey,
        state: {
          deactivationSlot: ALT_ACTIVE_DEACTIVATION_SLOT,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: [],
        },
      });

      const resolved = await resolveWireAddressLookupTables(
        encodeV0Tx(VAULT, [ix]),
        mockConnection(unusedLookupTable),
      );

      expect(resolved).to.have.lengthOf(0);
    });

    it('fails closed when a referenced table cannot be fetched', async () => {
      const ix = altOwnerInstruction();
      const { transactionBase58 } = encodeV0TxWithAlt(VAULT, [ix]);
      const unrelatedTable = new AddressLookupTableAccount({
        key: Keypair.generate().publicKey,
        state: {
          deactivationSlot: ALT_ACTIVE_DEACTIVATION_SLOT,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: [],
        },
      });

      let thrownMessage: string | undefined;
      try {
        await resolveWireAddressLookupTables(
          transactionBase58,
          mockConnection(unrelatedTable),
        );
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        if (error instanceof Error) {
          thrownMessage = error.message;
        }
      }
      expect(thrownMessage).to.contain(
        'referenced by the receipt wire could not be fetched',
      );
    });

    it('rejects a non-v0 (legacy) transaction message', async () => {
      const ix = ownerInstruction(VAULT);
      // Connection is never reached (the function throws before any RPC
      // call), so an empty-table stub is enough to satisfy the param type.
      const unusedLookupTable = new AddressLookupTableAccount({
        key: Keypair.generate().publicKey,
        state: {
          deactivationSlot: ALT_ACTIVE_DEACTIVATION_SLOT,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: [],
        },
      });

      let thrownMessage: string | undefined;
      try {
        await resolveWireAddressLookupTables(
          encodeLegacyTx(VAULT, [ix]),
          mockConnection(unusedLookupTable),
        );
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        if (error instanceof Error) {
          thrownMessage = error.message;
        }
      }
      expect(thrownMessage).to.equal('Expected a v0 transaction message');
    });
  });
});
