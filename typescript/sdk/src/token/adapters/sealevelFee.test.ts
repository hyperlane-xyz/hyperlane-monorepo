import { PublicKey, SystemProgram } from '@solana/web3.js';
import { expect } from 'chai';
import { deserializeUnchecked, serialize } from 'borsh';

import { SealevelInstructionWrapper } from '../../utils/sealevelSerialization.js';

import {
  SealevelFeeInstruction,
  SealevelGetQuoteAccountMetasInstruction,
  SealevelGetQuoteAccountMetasSchema,
  SealevelGetSubmitQuoteAccountMetasInstruction,
  SealevelGetSubmitQuoteAccountMetasSchema,
  SealevelQuoteFeeInstruction,
  SealevelQuoteFeeSchema,
  SealevelSubmitQuoteSchema,
  SealevelSvmSignedQuote,
  deriveFeeAccountPda,
  deriveFeeStandingQuotePda,
  deriveIgpStandingQuotePda,
  deriveIgpTransientQuotePda,
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

describe('SealevelSubmitQuoteSchema', () => {
  const FIXED_QUOTE = new SealevelSvmSignedQuote({
    context: new Uint8Array(44).fill(0x11),
    data: new Uint8Array(8).fill(0x22),
    issued_at: new Uint8Array(6).fill(0x33),
    expiry: new Uint8Array(6).fill(0x44),
    client_salt: new Uint8Array(32).fill(0x55),
    signature: new Uint8Array(65).fill(0x66),
  });

  // 1 (disc) + 4 (context u32 len) + 44 (context)
  // + 4 (data u32 len) + 8 (data) + 6 + 6 + 32 + 65 = 170
  const ENCODED_LEN = 1 + 4 + 44 + 4 + 8 + 6 + 6 + 32 + 65;

  it('encodes SubmitQuote (fee program) with disc=10 and correct byte length', () => {
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.SubmitQuote,
      data: FIXED_QUOTE,
    });
    const bytes = serialize(SealevelSubmitQuoteSchema, wrapped);

    expect(bytes[0]).to.equal(SealevelFeeInstruction.SubmitQuote);
    expect(bytes.length).to.equal(ENCODED_LEN);
  });

  it('lays SvmSignedQuote fields in the documented wire order', () => {
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.SubmitQuote,
      data: FIXED_QUOTE,
    });
    const bytes = serialize(SealevelSubmitQuoteSchema, wrapped);

    // context u32le len = 44
    expect(bytes[1]).to.equal(44);
    expect(bytes[2]).to.equal(0);
    // context body: 44 × 0x11
    expect([...bytes.subarray(5, 5 + 44)]).to.deep.equal([
      ...new Uint8Array(44).fill(0x11),
    ]);
    // data u32le len = 8 follows context body
    const dataLenOff = 5 + 44;
    expect(bytes[dataLenOff]).to.equal(8);
    expect([
      ...bytes.subarray(dataLenOff + 4, dataLenOff + 4 + 8),
    ]).to.deep.equal([...new Uint8Array(8).fill(0x22)]);
    // issued_at — 6 × 0x33
    const issuedAtOff = dataLenOff + 4 + 8;
    expect([...bytes.subarray(issuedAtOff, issuedAtOff + 6)]).to.deep.equal([
      ...new Uint8Array(6).fill(0x33),
    ]);
    // expiry — 6 × 0x44
    const expiryOff = issuedAtOff + 6;
    expect([...bytes.subarray(expiryOff, expiryOff + 6)]).to.deep.equal([
      ...new Uint8Array(6).fill(0x44),
    ]);
    // client_salt — 32 × 0x55
    const saltOff = expiryOff + 6;
    expect([...bytes.subarray(saltOff, saltOff + 32)]).to.deep.equal([
      ...new Uint8Array(32).fill(0x55),
    ]);
    // signature — 65 × 0x66
    const sigOff = saltOff + 32;
    expect([...bytes.subarray(sigOff, sigOff + 65)]).to.deep.equal([
      ...new Uint8Array(65).fill(0x66),
    ]);
  });

  it('round-trips an encoded SubmitQuote back to the original quote fields', () => {
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.SubmitQuote,
      data: FIXED_QUOTE,
    });
    const bytes = serialize(SealevelSubmitQuoteSchema, wrapped);

    const decoded = deserializeUnchecked(
      SealevelSubmitQuoteSchema,
      SealevelInstructionWrapper,
      Buffer.from(bytes),
    );

    expect(decoded.instruction).to.equal(SealevelFeeInstruction.SubmitQuote);
    const q = decoded.data as SealevelSvmSignedQuote;
    expect(Array.from(q.context)).to.deep.equal(
      Array.from(FIXED_QUOTE.context),
    );
    expect(Array.from(q.data)).to.deep.equal(Array.from(FIXED_QUOTE.data));
    expect(Array.from(q.issued_at)).to.deep.equal(
      Array.from(FIXED_QUOTE.issued_at),
    );
    expect(Array.from(q.expiry)).to.deep.equal(Array.from(FIXED_QUOTE.expiry));
    expect(Array.from(q.client_salt)).to.deep.equal(
      Array.from(FIXED_QUOTE.client_salt),
    );
    expect(Array.from(q.signature)).to.deep.equal(
      Array.from(FIXED_QUOTE.signature),
    );
  });

  it('IGP SubmitIgpQuote shares the wire shape — only disc differs', () => {
    const SUBMIT_IGP_QUOTE_DISC = 14;
    const wrapped = new SealevelInstructionWrapper({
      instruction: SUBMIT_IGP_QUOTE_DISC,
      data: FIXED_QUOTE,
    });
    const bytes = serialize(SealevelSubmitQuoteSchema, wrapped);

    expect(bytes[0]).to.equal(SUBMIT_IGP_QUOTE_DISC);
    expect(bytes.length).to.equal(ENCODED_LEN);
  });
});

describe('SealevelGetSubmitQuoteAccountMetasSchema', () => {
  it('encodes the standing variant (scoped_salt = null)', () => {
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.GetSubmitQuoteAccountMetas,
      data: new SealevelGetSubmitQuoteAccountMetasInstruction({
        destination_domain: 8453,
        target_router: new Uint8Array(32).fill(0x77),
        scoped_salt: null,
      }),
    });
    const bytes = serialize(SealevelGetSubmitQuoteAccountMetasSchema, wrapped);

    expect(bytes.length).to.equal(1 + 4 + 32 + 1);
    expect(bytes[0]).to.equal(
      SealevelFeeInstruction.GetSubmitQuoteAccountMetas,
    );
    expect(bytes[bytes.length - 1]).to.equal(0); // Option::None tag
  });

  it('encodes the transient variant (scoped_salt = Some)', () => {
    const wrapped = new SealevelInstructionWrapper({
      instruction: SealevelFeeInstruction.GetSubmitQuoteAccountMetas,
      data: new SealevelGetSubmitQuoteAccountMetasInstruction({
        destination_domain: 8453,
        target_router: new Uint8Array(32).fill(0x77),
        scoped_salt: new Uint8Array(32).fill(0x88),
      }),
    });
    const bytes = serialize(SealevelGetSubmitQuoteAccountMetasSchema, wrapped);

    expect(bytes.length).to.equal(1 + 4 + 32 + 1 + 32);
    expect(bytes[1 + 4 + 32]).to.equal(1); // Option::Some tag
  });
});

describe('deriveIgpTransientQuotePda', () => {
  it('is deterministic for the same scopedSalt', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const a = deriveIgpTransientQuotePda(TEST_PROGRAM, TEST_FEE_ACCOUNT, salt);
    const b = deriveIgpTransientQuotePda(TEST_PROGRAM, TEST_FEE_ACCOUNT, salt);
    expect(a.toBase58()).to.equal(b.toBase58());
  });

  it('differs from the standing IGP PDA for the same igp+domain+sender', () => {
    const transient = deriveIgpTransientQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      new Uint8Array(32).fill(0x42),
    );
    const standing = deriveIgpStandingQuotePda(
      TEST_PROGRAM,
      TEST_FEE_ACCOUNT,
      SystemProgram.programId,
      10,
      TEST_PROGRAM,
    );
    expect(transient.toBase58()).to.not.equal(standing.toBase58());
  });

  it('rejects scopedSalt of the wrong length', () => {
    expect(() =>
      deriveIgpTransientQuotePda(
        TEST_PROGRAM,
        TEST_FEE_ACCOUNT,
        new Uint8Array(16),
      ),
    ).to.throw('scopedSalt must be 32 bytes');
  });
});
