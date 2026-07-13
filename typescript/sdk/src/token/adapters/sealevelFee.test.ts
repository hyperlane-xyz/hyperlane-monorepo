import { PublicKey, SystemProgram } from '@solana/web3.js';
import { expect } from 'chai';
import { serialize } from 'borsh';

import { SealevelInstructionWrapper } from '../../utils/sealevelSerialization.js';

import {
  SealevelFeeInstruction,
  SealevelGetQuoteAccountMetasInstruction,
  SealevelGetQuoteAccountMetasSchema,
  SealevelQuoteFeeInstruction,
  SealevelQuoteFeeSchema,
  deriveFeeAccountPda,
  deriveFeeStandingQuotePda,
  deriveIgpStandingQuotePda,
  parseSimulationAccountMetas,
} from './sealevelFee.js';

const TEST_PROGRAM = new PublicKey(
  'AyD8sj1iCNDmF7QKytrkF35cE9NipJ4UNkCJSiPnEKAQ',
);
const TEST_FEE_ACCOUNT = new PublicKey(
  '9Ngnk7jVz9LFmddRPm3JknUYsbDpVQqJj1Sb3upDtRfQ',
);

describe('SealevelQuoteFeeSchema', () => {
  it('encodes QuoteFee with the expected byte layout', () => {
    const recipient = new Uint8Array(32).fill(0x11);
    const targetRouter = new Uint8Array(32).fill(0x22);
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.QuoteFee,
      data: new SealevelQuoteFeeInstruction({
        destination_domain: 1337,
        recipient,
        amount: 1000n,
        target_router: targetRouter,
      }),
    });
    const bytes = serialize(SealevelQuoteFeeSchema, wrapped);
    expect(bytes.length).to.equal(1 + 4 + 32 + 8 + 32);
    expect(bytes[0]).to.equal(SealevelFeeInstruction.QuoteFee);
  });
});

describe('SealevelGetQuoteAccountMetasSchema', () => {
  it('encodes the standing variant (scoped_salt = null) as 38 bytes', () => {
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.GetQuoteAccountMetas,
      data: new SealevelGetQuoteAccountMetasInstruction({
        destination_domain: 42,
        target_router: new Uint8Array(32).fill(0x33),
        scoped_salt: null,
      }),
    });
    const bytes = serialize(SealevelGetQuoteAccountMetasSchema, wrapped);
    expect(bytes.length).to.equal(1 + 4 + 32 + 1);
    expect(bytes[0]).to.equal(SealevelFeeInstruction.GetQuoteAccountMetas);
    expect(bytes[bytes.length - 1]).to.equal(0); // Option::None tag
  });

  it('encodes the transient variant (scoped_salt = Some) as 70 bytes', () => {
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.GetQuoteAccountMetas,
      data: new SealevelGetQuoteAccountMetasInstruction({
        destination_domain: 42,
        target_router: new Uint8Array(32).fill(0x33),
        scoped_salt: new Uint8Array(32).fill(0x44),
      }),
    });
    const bytes = serialize(SealevelGetQuoteAccountMetasSchema, wrapped);
    expect(bytes.length).to.equal(1 + 4 + 32 + 1 + 32);
    expect(bytes[1 + 4 + 32]).to.equal(1); // Option::Some tag
  });
});

describe('PDA derivers', () => {
  const salt = new Uint8Array(32).fill(0x99);

  it('deriveFeeAccountPda is deterministic', () => {
    const a = deriveFeeAccountPda(TEST_PROGRAM, salt);
    const b = deriveFeeAccountPda(TEST_PROGRAM, salt);
    expect(a.toBase58()).to.equal(b.toBase58());
  });

  it('deriveFeeStandingQuotePda uses H256::zero() sentinel for Leaf/Routing', () => {
    const leafPda = deriveFeeStandingQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      10,
      null,
    );
    const explicitZero = deriveFeeStandingQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      10,
      new Uint8Array(32),
    );
    expect(leafPda.toBase58()).to.equal(explicitZero.toBase58());
  });

  it('deriveFeeStandingQuotePda differentiates Leaf vs CC by target_router', () => {
    const leafPda = deriveFeeStandingQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      10,
      null,
    );
    const ccPda = deriveFeeStandingQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      10,
      new Uint8Array(32).fill(0xab),
    );
    expect(leafPda.toBase58()).to.not.equal(ccPda.toBase58());
  });

  it('deriveIgpStandingQuotePda includes fee_token_mint in seeds', () => {
    const native = deriveIgpStandingQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      SystemProgram.programId,
      10,
      TEST_PROGRAM,
    );
    const spl = deriveIgpStandingQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      new PublicKey('Fefw54S6NDdwNbPngPePvW4tiFTFQDT7gBPvFoDFeGqg'),
      10,
      TEST_PROGRAM,
    );
    expect(native.toBase58()).to.not.equal(spl.toBase58());
  });
});

describe('parseSimulationAccountMetas', () => {
  it('decodes a vec with multiple entries', () => {
    const k1 = Buffer.alloc(32, 0xaa);
    const k2 = Buffer.alloc(32, 0xbb);
    const data = Buffer.concat([
      Buffer.from([0x02, 0x00, 0x00, 0x00]), // len = 2
      k1,
      Buffer.from([0x01, 0x00]), // signer=true, writable=false
      k2,
      Buffer.from([0x00, 0x01]), // signer=false, writable=true
    ]);
    const metas = parseSimulationAccountMetas(data);
    expect(metas.length).to.equal(2);
    expect(metas[0].isSigner).to.equal(true);
    expect(metas[0].isWritable).to.equal(false);
    expect(metas[1].isSigner).to.equal(false);
    expect(metas[1].isWritable).to.equal(true);
    expect(metas[0].pubkey.toBuffer().equals(k1)).to.equal(true);
    expect(metas[1].pubkey.toBuffer().equals(k2)).to.equal(true);
  });

  it('decodes an empty vec', () => {
    const metas = parseSimulationAccountMetas(
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    );
    expect(metas).to.deep.equal([]);
  });

  it('throws on truncated length prefix', () => {
    expect(() => parseSimulationAccountMetas(Buffer.from([0x00]))).to.throw(
      'Simulation return data too short',
    );
  });

  it('throws on truncated vec body', () => {
    const data = Buffer.concat([
      Buffer.from([0x02, 0x00, 0x00, 0x00]), // claims 2 entries
      Buffer.alloc(34, 0xaa), // only 1 entry follows
    ]);
    expect(() => parseSimulationAccountMetas(data)).to.throw(
      'Truncated Vec<SerializableAccountMeta>',
    );
  });
});
