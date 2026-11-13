import { AccountRole } from '@solana/kit';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import bs58 from 'bs58';

import {
  LOADER_V3,
  MAX_COMPUTE_UNITS,
  assertProgramBinaryFitsCurrentCapacity,
  sanitizeSingleMailboxUpgradeReceiptForSquads,
} from '../src/utils/mailbox-upgrade.js';
import {
  type PrintableSvmTransaction,
  assertAuthorizedByVault,
  assertSimpleReceipt,
  planReceiptProposals,
} from '../src/utils/warp-propose-squads.js';

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const MAILBOX = 'E588QtVUfdTiQK6K7WKySi5GmHAbkMyT4hETvQG9gAhp';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
const SPILL = Keypair.generate().publicKey.toBase58();
const UPGRADE_AUTHORITY = '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa';

describe('assertProgramBinaryFitsCurrentCapacity', () => {
  it('accepts a binary that exactly fits the current capacity', () => {
    expect(
      assertProgramBinaryFitsCurrentCapacity({
        programBinarySize: 100,
        programDataAccountSize: 145,
      }),
    ).to.equal(100);
  });

  it('rejects a binary that requires a ProgramData extension', () => {
    expect(() =>
      assertProgramBinaryFitsCurrentCapacity({
        programBinarySize: 101,
        programDataAccountSize: 145,
      }),
    ).to.throw('an Extend transaction is required');
  });
});

function programDataAddress(program: string): string {
  const [programData] = PublicKey.findProgramAddressSync(
    [new PublicKey(program).toBuffer()],
    new PublicKey(LOADER_V3),
  );
  return programData.toBase58();
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

function buildReceipt({
  mailbox = MAILBOX,
  authority = UPGRADE_AUTHORITY,
  spill = SPILL,
  instructionCount = 1,
  waitForSlotAdvance = true,
  computeUnits = MAX_COMPUTE_UNITS,
  loader = LOADER_V3,
  instructionData = Buffer.from([3, 0, 0, 0]),
}: {
  mailbox?: string;
  authority?: string;
  spill?: string;
  instructionCount?: number;
  waitForSlotAdvance?: boolean;
  computeUnits?: number;
  loader?: string;
  instructionData?: Buffer;
} = {}): PrintableSvmTransaction {
  const upgrade = new TransactionInstruction({
    programId: new PublicKey(loader),
    keys: [
      {
        pubkey: new PublicKey(programDataAddress(mailbox)),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: new PublicKey(mailbox),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: new PublicKey(spill),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: new PublicKey(RENT_SYSVAR),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey(CLOCK_SYSVAR),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey(authority),
        isSigner: true,
        isWritable: false,
      },
    ],
    data: instructionData,
  });
  const instructions = Array.from({ length: instructionCount }, () => upgrade);

  return {
    transaction_base58: encodeV0Tx(authority, instructions),
    instructions: instructions.map((instruction) => ({
      programAddress: instruction.programId.toBase58(),
      accounts: instruction.keys.map((key) => ({
        address: key.pubkey.toBase58(),
        role: key.isSigner
          ? key.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : key.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      })),
      data: instruction.data.toString('hex'),
    })),
    waitForSlotAdvance,
    computeUnits,
  };
}

function sanitize(
  transactions: readonly PrintableSvmTransaction[],
): PrintableSvmTransaction[] {
  return sanitizeSingleMailboxUpgradeReceiptForSquads({
    transactions,
    mailbox: MAILBOX,
    upgradeAuthority: UPGRADE_AUTHORITY,
    spillAddress: SPILL,
  });
}

describe('sanitizeSingleMailboxUpgradeReceiptForSquads', () => {
  it('exports a one-transaction receipt accepted by the normal proposer', () => {
    const sanitized = sanitize([buildReceipt()]);

    expect(sanitized).to.have.lengthOf(1);
    expect(sanitized[0]).not.to.have.property('waitForSlotAdvance');
    expect(assertSimpleReceipt(sanitized)).to.deep.equal({ ok: true });

    const plans = planReceiptProposals(sanitized, [[]]);
    expect(plans).to.have.lengthOf(1);
    expect(plans[0].computeUnits).to.equal(MAX_COMPUTE_UNITS);
    expect(assertAuthorizedByVault(plans, UPGRADE_AUTHORITY)).to.deep.equal({
      ok: true,
    });
  });

  it('rejects multiple authority transactions', () => {
    const receipt = buildReceipt();
    expect(() => sanitize([receipt, receipt])).to.throw(
      'Expected exactly one mailbox upgrade transaction',
    );
  });

  it('rejects multiple instructions', () => {
    expect(() => sanitize([buildReceipt({ instructionCount: 2 })])).to.throw(
      'Expected exactly one mailbox upgrade instruction',
    );
  });

  it('rejects a missing slot barrier', () => {
    expect(() =>
      sanitize([buildReceipt({ waitForSlotAdvance: false })]),
    ).to.throw('require waitForSlotAdvance');
  });

  it('rejects a non-max compute budget', () => {
    expect(() => sanitize([buildReceipt({ computeUnits: 400_000 })])).to.throw(
      'use 1400000 compute units',
    );
  });

  it('rejects a different loader program', () => {
    const foreignLoader = Keypair.generate().publicKey.toBase58();
    expect(() => sanitize([buildReceipt({ loader: foreignLoader })])).to.throw(
      'Expected loader-v3 instruction',
    );
  });

  it('rejects a non-Upgrade loader instruction', () => {
    expect(() =>
      sanitize([buildReceipt({ instructionData: Buffer.from([4, 0, 0, 0]) })]),
    ).to.throw('Expected loader Upgrade data 03000000');
  });

  it('rejects a different mailbox', () => {
    const foreignMailbox = Keypair.generate().publicKey.toBase58();
    expect(() =>
      sanitize([buildReceipt({ mailbox: foreignMailbox })]),
    ).to.throw('Unexpected loader Upgrade account 0');
  });

  it('rejects a different upgrade authority', () => {
    const foreignAuthority = Keypair.generate().publicKey.toBase58();
    expect(() =>
      sanitize([buildReceipt({ authority: foreignAuthority })]),
    ).to.throw('Unexpected loader Upgrade account 6');
  });

  it('rejects a different spill account', () => {
    const foreignSpill = Keypair.generate().publicKey.toBase58();
    expect(() => sanitize([buildReceipt({ spill: foreignSpill })])).to.throw(
      'Unexpected loader Upgrade account 3',
    );
  });

  it('rejects expanded instructions that differ from the wire payload', () => {
    const receipt = buildReceipt();
    receipt.transaction_base58 = buildReceipt().transaction_base58;
    expect(() => sanitize([receipt])).to.throw(
      'Receipt instructions do not match wire payload',
    );
  });
});
