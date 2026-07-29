import { expect } from 'chai';

import {
  decodeCrossCollateralRoute,
  decodeFeeAccount,
  decodeRouteDomain,
  decodeStandingQuotePda,
} from '../accounts/fee.js';
import { FeeDataKind, FeeStrategyKind } from '../fee/types.js';

// Golden-vector layout lock for the discriminated fee account decoders.
//
// The raw account bytes below are hand-assembled byte literals, NOT produced by
// the SDK's own encode functions. Building them from the encoders would only
// prove encoder-decoder self-consistency; the point here is that these bytes are
// a fixed golden vector so that any drift in a decoder's field order/size makes
// decoding these bytes produce wrong values and fail the test.
//
// Wire framing for every fixture (see codecs/account-data.ts + accounts/fee.ts):
//   [0x01 initialized] ++ [8-byte discriminator] ++ inner payload

/** Concatenates byte sections into one buffer. */
function bytes(...sections: number[][]): Uint8Array {
  return Uint8Array.from(sections.flat());
}

// ====== Discriminators (8-byte ASCII, from codecs/fee.ts) ======

const FEE_ACCT = [0x46, 0x45, 0x45, 0x5f, 0x41, 0x43, 0x43, 0x54]; // "FEE_ACCT"
const ROUTEDOM = [0x52, 0x4f, 0x55, 0x54, 0x45, 0x44, 0x4f, 0x4d]; // "ROUTEDOM"
const CC_ROUTE = [0x43, 0x43, 0x5f, 0x52, 0x4f, 0x55, 0x54, 0x45]; // "CC_ROUTE"
const STDQUOTE = [0x53, 0x54, 0x44, 0x51, 0x55, 0x4f, 0x54, 0x45]; // "STDQUOTE"

// ====== Fixed test values ======

// 32-byte Address vectors -> base58 (translation via @solana/kit is standard
// encoding, not the layout under test).
// owner bytes: 0xa0..0xaf repeated -> "Bp3BbhbyBNoTt3LgewDgCezdiUAWKxiWq18vdj3PVUiS"
const OWNER_BYTES = [
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac,
  0xad, 0xae, 0xaf, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
  0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];
const OWNER_BASE58 = 'Bp3BbhbyBNoTt3LgewDgCezdiUAWKxiWq18vdj3PVUiS';

// beneficiary bytes: 0x01..0x20 -> "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw"
const BENEFICIARY_BYTES = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
  0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a,
  0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
];
const BENEFICIARY_BASE58 = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw';

// 20-byte H160 signers -> lowercase 0x + 40 hex (h160ToSigner in fee/types.ts).
const SIGNER_A_BYTES = [
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
  0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23,
];
const SIGNER_A_HEX = '0x101112131415161718191a1b1c1d1e1f20212223';
const SIGNER_B_BYTES = [
  0xf0, 0xef, 0xee, 0xed, 0xec, 0xeb, 0xea, 0xe9, 0xe8, 0xe7, 0xe6, 0xe5, 0xe4,
  0xe3, 0xe2, 0xe1, 0xe0, 0xdf, 0xde, 0xdd,
];
const SIGNER_B_HEX = '0xf0efeeedecebeae9e8e7e6e5e4e3e2e1e0dfdedd';

// 32-byte H256 standing-quote map key -> lowercase 0x + 64 hex (toHexString).
const QUOTE_KEY_BYTES = [
  0x03, 0x0a, 0x11, 0x18, 0x1f, 0x26, 0x2d, 0x34, 0x3b, 0x42, 0x49, 0x50, 0x57,
  0x5e, 0x65, 0x6c, 0x73, 0x7a, 0x81, 0x88, 0x8f, 0x96, 0x9d, 0xa4, 0xab, 0xb2,
  0xb9, 0xc0, 0xc7, 0xce, 0xd5, 0xdc,
];
const QUOTE_KEY_HEX =
  '0x030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc';

// u64 LE helper values, written as raw little-endian byte sections below:
//   maxFee    = 1000 = 0xe8,0x03,0,0,0,0,0,0
//   halfAmount= 500  = 0xf4,0x01,0,0,0,0,0,0

describe('SVM fee account golden-vector decode', () => {
  it('decodeFeeAccount: owner Some, Leaf strategy Linear, signers Some', () => {
    const raw = bytes(
      [0x01], // initialized = true
      FEE_ACCT, // discriminator
      [0x07], // bumpSeed = 7
      [0x01], // owner Option tag = Some
      OWNER_BYTES, // owner address (32 bytes)
      BENEFICIARY_BYTES, // beneficiary address (32 bytes)
      [0x39, 0x05, 0x00, 0x00], // domainId u32 LE = 1337
      [0x80, 0x51, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00], // minIssuedAt i64 LE = 86400
      [FeeDataKind.Leaf], // feeData kind = Leaf (0)
      [FeeStrategyKind.Linear], // strategy kind = Linear (0)
      [0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // maxFee u64 LE = 1000
      [0xf4, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // halfAmount u64 LE = 500
      [0x01], // signers Option tag = Some
      [0x02, 0x00, 0x00, 0x00], // BTreeSet count u32 LE = 2
      SIGNER_A_BYTES, // signer[0] (20 bytes)
      SIGNER_B_BYTES, // signer[1] (20 bytes)
    );

    const decoded = decodeFeeAccount(raw);
    expect(decoded).to.not.equal(null);
    if (decoded === null) throw new Error('unreachable');

    expect(decoded.bumpSeed).to.equal(7);
    expect(decoded.owner).to.equal(OWNER_BASE58);
    expect(decoded.beneficiary).to.equal(BENEFICIARY_BASE58);
    expect(decoded.domainId).to.equal(1337);
    expect(decoded.minIssuedAt).to.equal(86400n);
    expect(decoded.feeData.kind).to.equal(FeeDataKind.Leaf);
    if (decoded.feeData.kind !== FeeDataKind.Leaf)
      throw new Error('unreachable');
    expect(decoded.feeData.strategy.kind).to.equal(FeeStrategyKind.Linear);
    expect(decoded.feeData.strategy.params.maxFee).to.equal(1000n);
    expect(decoded.feeData.strategy.params.halfAmount).to.equal(500n);
    expect(decoded.feeData.signers).to.deep.equal([SIGNER_A_HEX, SIGNER_B_HEX]);
  });

  it('decodeFeeAccount: owner None, Leaf strategy Regressive, signers None', () => {
    const raw = bytes(
      [0x01], // initialized = true
      FEE_ACCT, // discriminator
      [0xff], // bumpSeed = 255
      [0x00], // owner Option tag = None
      BENEFICIARY_BYTES, // beneficiary address (32 bytes)
      [0x00, 0x00, 0x00, 0x00], // domainId u32 LE = 0
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], // minIssuedAt i64 LE = -1
      [FeeDataKind.Leaf], // feeData kind = Leaf (0)
      [FeeStrategyKind.Regressive], // strategy kind = Regressive (1)
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // maxFee u64 LE = 0
      [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // halfAmount u64 LE = 1
      [0x00], // signers Option tag = None
    );

    const decoded = decodeFeeAccount(raw);
    expect(decoded).to.not.equal(null);
    if (decoded === null) throw new Error('unreachable');

    expect(decoded.bumpSeed).to.equal(255);
    expect(decoded.owner).to.equal(null);
    expect(decoded.beneficiary).to.equal(BENEFICIARY_BASE58);
    expect(decoded.domainId).to.equal(0);
    expect(decoded.minIssuedAt).to.equal(-1n);
    expect(decoded.feeData.kind).to.equal(FeeDataKind.Leaf);
    if (decoded.feeData.kind !== FeeDataKind.Leaf)
      throw new Error('unreachable');
    expect(decoded.feeData.strategy.kind).to.equal(FeeStrategyKind.Regressive);
    expect(decoded.feeData.strategy.params.maxFee).to.equal(0n);
    expect(decoded.feeData.strategy.params.halfAmount).to.equal(1n);
    expect(decoded.feeData.signers).to.equal(null);
  });

  it('decodeRouteDomain: strategy Regressive, signers None', () => {
    const raw = bytes(
      [0x01], // initialized = true
      ROUTEDOM, // discriminator
      [0x2a], // bumpSeed = 42
      [FeeStrategyKind.Regressive], // strategy kind = Regressive (1)
      [0x10, 0x27, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // maxFee u64 LE = 10000
      [0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // halfAmount u64 LE = 1000
      [0x00], // signers Option tag = None
    );

    const decoded = decodeRouteDomain(raw);
    expect(decoded).to.not.equal(null);
    if (decoded === null) throw new Error('unreachable');

    expect(decoded.bumpSeed).to.equal(42);
    expect(decoded.feeData.kind).to.equal(FeeStrategyKind.Regressive);
    expect(decoded.feeData.params.maxFee).to.equal(10000n);
    expect(decoded.feeData.params.halfAmount).to.equal(1000n);
    expect(decoded.signers).to.equal(null);
  });

  it('decodeCrossCollateralRoute: strategy Progressive, signers Some (1)', () => {
    const raw = bytes(
      [0x01], // initialized = true
      CC_ROUTE, // discriminator
      [0x09], // bumpSeed = 9
      [FeeStrategyKind.Progressive], // strategy kind = Progressive (2)
      [0x40, 0x42, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00], // maxFee u64 LE = 1000000
      [0xa0, 0x86, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00], // halfAmount u64 LE = 100000
      [0x01], // signers Option tag = Some
      [0x01, 0x00, 0x00, 0x00], // BTreeSet count u32 LE = 1
      SIGNER_A_BYTES, // signer[0] (20 bytes)
    );

    const decoded = decodeCrossCollateralRoute(raw);
    expect(decoded).to.not.equal(null);
    if (decoded === null) throw new Error('unreachable');

    expect(decoded.bumpSeed).to.equal(9);
    expect(decoded.feeData.kind).to.equal(FeeStrategyKind.Progressive);
    expect(decoded.feeData.params.maxFee).to.equal(1000000n);
    expect(decoded.feeData.params.halfAmount).to.equal(100000n);
    expect(decoded.signers).to.deep.equal([SIGNER_A_HEX]);
  });

  it('decodeStandingQuotePda: one map entry, strategy Linear', () => {
    const raw = bytes(
      [0x01], // initialized = true
      STDQUOTE, // discriminator
      [0xfe], // bumpSeed = 254
      [0x01, 0x00, 0x00, 0x00], // map count u32 LE = 1
      QUOTE_KEY_BYTES, // entry key (32 bytes)
      [0x00, 0xe1, 0xf5, 0x05, 0x00, 0x00, 0x00, 0x00], // issuedAt i64 LE = 100000000
      [0x00, 0xc2, 0xeb, 0x0b, 0x00, 0x00, 0x00, 0x00], // expiry i64 LE = 200000000
      [FeeStrategyKind.Linear], // strategy kind = Linear (0)
      [0x2c, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // maxFee u64 LE = 300
      [0x96, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // halfAmount u64 LE = 150
    );

    const decoded = decodeStandingQuotePda(raw);
    expect(decoded).to.not.equal(null);
    if (decoded === null) throw new Error('unreachable');

    expect(decoded.bumpSeed).to.equal(254);
    expect(decoded.quotes.size).to.equal(1);
    const entry = decoded.quotes.get(QUOTE_KEY_HEX);
    expect(entry).to.not.equal(undefined);
    if (entry === undefined) throw new Error('unreachable');
    expect(entry.issuedAt).to.equal(100000000n);
    expect(entry.expiry).to.equal(200000000n);
    expect(entry.feeData.kind).to.equal(FeeStrategyKind.Linear);
    expect(entry.feeData.params.maxFee).to.equal(300n);
    expect(entry.feeData.params.halfAmount).to.equal(150n);
  });

  it('returns null for empty and uninitialized buffers', () => {
    const empty = new Uint8Array(0);
    const uninitialized = bytes([0x00], FEE_ACCT, [0x07]);

    expect(decodeFeeAccount(empty)).to.equal(null);
    expect(decodeFeeAccount(uninitialized)).to.equal(null);
    expect(decodeRouteDomain(empty)).to.equal(null);
    expect(decodeRouteDomain(uninitialized)).to.equal(null);
    expect(decodeCrossCollateralRoute(empty)).to.equal(null);
    expect(decodeStandingQuotePda(empty)).to.equal(null);
  });
});
