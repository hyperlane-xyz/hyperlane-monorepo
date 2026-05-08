import {
  type Address,
  address as parseAddress,
  getAddressEncoder,
} from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { describe, it } from 'mocha';

chai.use(chaiAsPromised);

import {
  deriveIgpStandingQuotePda,
  deriveIgpTransientQuotePda,
} from '../pda.js';

import { ascii8 } from './account-data.js';
import { concatBytes, i64le, u128le, u32le } from './binary.js';
import {
  decodeIgpStandingQuoteAccount,
  decodeIgpTransientQuoteAccount,
  type IgpStandingQuoteData,
  type IgpTransientQuoteData,
  WILDCARD_DOMAIN,
  WILDCARD_SENDER,
} from './igp.js';

const IGP_PROGRAM: Address = parseAddress(
  'GZGLpeuMaUXUmBHh1EtgWQDufyUoHapAKFfgKb6u8o3h',
);
const IGP_ACCOUNT: Address = parseAddress('11111111111111111111111111111111');
const FEE_TOKEN_MINT: Address = parseAddress(
  '11111111111111111111111111111111',
);
const SENDER_A: Address = parseAddress(
  '2nss3sLwiUCP98rXQ6FciJ35cDeSLu3VEU5mFRa7p43J',
);
const SENDER_B: Address = parseAddress(
  '4ZiKsHnTUbgH97sMggds4NfV31yBB3hsJJEKk1Fj8NyL',
);
const SCOPED_SALT_A = new Uint8Array(32).fill(1);
const SCOPED_SALT_B = new Uint8Array(32).fill(2);

const addressEncoder = getAddressEncoder();
const STANDING_DISC = ascii8('IGPSTQTE');
const TRANSIENT_DISC = ascii8('IGPTQOTE');

describe('IGP quote PDA derivers', () => {
  it('standing quote PDA is deterministic', async () => {
    const a = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      FEE_TOKEN_MINT,
      1,
      SENDER_A,
    );
    const b = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      FEE_TOKEN_MINT,
      1,
      SENDER_A,
    );
    expect(a.address).to.equal(b.address);
    expect(a.bump).to.be.within(0, 255);
  });

  it('standing quote PDA differs by sender', async () => {
    const a = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      FEE_TOKEN_MINT,
      1,
      SENDER_A,
    );
    const b = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      FEE_TOKEN_MINT,
      1,
      SENDER_B,
    );
    expect(a.address).to.not.equal(b.address);
  });

  it('standing quote PDA differs by domain', async () => {
    const a = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      FEE_TOKEN_MINT,
      1,
      SENDER_A,
    );
    const b = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      FEE_TOKEN_MINT,
      2,
      SENDER_A,
    );
    expect(a.address).to.not.equal(b.address);
  });

  it('transient quote PDA differs by scoped salt', async () => {
    const a = await deriveIgpTransientQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      SCOPED_SALT_A,
    );
    const b = await deriveIgpTransientQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      SCOPED_SALT_B,
    );
    expect(a.address).to.not.equal(b.address);
  });

  it('transient quote PDA rejects non-32-byte scoped salt', async () => {
    await expect(
      deriveIgpTransientQuotePda(IGP_PROGRAM, IGP_ACCOUNT, new Uint8Array(31)),
    ).to.be.rejectedWith(/scopedSalt must be 32 bytes/);
  });
});

describe('IGP wildcard constants', () => {
  it('WILDCARD_SENDER is Pubkey([0xFF; 32])', () => {
    const bytes = addressEncoder.encode(WILDCARD_SENDER);
    expect(bytes).to.have.length(32);
    expect(Array.from(bytes).every((b) => b === 0xff)).to.equal(true);
  });

  it('WILDCARD_DOMAIN is u32::MAX', () => {
    expect(WILDCARD_DOMAIN).to.equal(0xffffffff);
  });
});

describe('IGP standing/transient quote decoders', () => {
  it('round-trips standing quote', () => {
    const expected: IgpStandingQuoteData = {
      bumpSeed: 254,
      feeTokenMint: FEE_TOKEN_MINT,
      destinationDomain: 137,
      sender: SENDER_A,
      tokenExchangeRate: 1_000_000_000_000_000_000n,
      gasPrice: 50_000_000_000n,
      tokenDecimals: 9,
      issuedAt: 1_700_000_000n,
      expiry: 1_700_000_300n,
    };
    const raw = Uint8Array.from(
      concatBytes(
        new Uint8Array([1]),
        STANDING_DISC,
        new Uint8Array([expected.bumpSeed]),
        addressEncoder.encode(expected.feeTokenMint),
        u32le(expected.destinationDomain),
        addressEncoder.encode(expected.sender),
        u128le(expected.tokenExchangeRate),
        u128le(expected.gasPrice),
        new Uint8Array([expected.tokenDecimals]),
        i64le(expected.issuedAt),
        i64le(expected.expiry),
      ),
    );
    expect(decodeIgpStandingQuoteAccount(raw)).to.eql(expected);
  });

  it('round-trips transient quote', () => {
    const expected: IgpTransientQuoteData = {
      bumpSeed: 253,
      payer: SENDER_A,
      scopedSalt: SCOPED_SALT_A,
      destinationDomain: 1,
      sender: SENDER_B,
      tokenExchangeRate: 2n,
      gasPrice: 3n,
      tokenDecimals: 6,
      expiry: 1_700_000_500n,
    };
    const raw = Uint8Array.from(
      concatBytes(
        new Uint8Array([1]),
        TRANSIENT_DISC,
        new Uint8Array([expected.bumpSeed]),
        addressEncoder.encode(expected.payer),
        expected.scopedSalt,
        u32le(expected.destinationDomain),
        addressEncoder.encode(expected.sender),
        u128le(expected.tokenExchangeRate),
        u128le(expected.gasPrice),
        new Uint8Array([expected.tokenDecimals]),
        i64le(expected.expiry),
      ),
    );
    expect(decodeIgpTransientQuoteAccount(raw)).to.eql(expected);
  });

  it('throws when the standing-quote discriminator is wrong', () => {
    const raw = Uint8Array.from(
      concatBytes(new Uint8Array([1]), TRANSIENT_DISC, new Uint8Array(118)),
    );
    expect(() => decodeIgpStandingQuoteAccount(raw)).to.throw(
      /Invalid discriminator/,
    );
  });
});
