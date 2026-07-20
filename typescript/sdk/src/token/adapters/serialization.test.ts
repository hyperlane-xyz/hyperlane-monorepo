import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';

import {
  SealevelTokenFeeConfig,
  decodeTrailingFeeConfig,
} from './serialization.js';

describe('decodeTrailingFeeConfig', () => {
  const HEADER_SIZE = 50;
  const PLUGIN_SIZE = 98;
  // `FeeConfig::DISCRIMINATOR` in hyperlane-sealevel-token/src/accounts.rs.
  const DISCRIMINATOR = Buffer.from('TOKFEEV1', 'ascii');
  const FEE_PROGRAM = new PublicKey(
    'AyD8sj1iCNDmF7QKytrkF35cE9NipJ4UNkCJSiPnEKAQ',
  );
  const FEE_ACCOUNT = new PublicKey(
    '9Ngnk7jVz9LFmddRPm3JknUYsbDpVQqJj1Sb3upDtRfQ',
  );

  function build(trailing: Buffer | null): Buffer {
    const header = Buffer.alloc(HEADER_SIZE, 0xff);
    const plugin = Buffer.alloc(PLUGIN_SIZE, 0xaa);
    return trailing
      ? Buffer.concat([header, plugin, trailing])
      : Buffer.concat([header, plugin]);
  }

  it('returns undefined for pre-upgrade accounts (no trailing bytes)', () => {
    expect(
      decodeTrailingFeeConfig(build(null), HEADER_SIZE, PLUGIN_SIZE),
    ).to.equal(undefined);
  });

  it('returns undefined for a tail shorter than the discriminator', () => {
    expect(
      decodeTrailingFeeConfig(
        build(Buffer.from([0])),
        HEADER_SIZE,
        PLUGIN_SIZE,
      ),
    ).to.equal(undefined);
  });

  it('returns undefined for a stale non-matching tail', () => {
    // Over-allocated account with stale bytes that must not be read as Some.
    const stale = Buffer.alloc(72, 0x01);
    expect(
      decodeTrailingFeeConfig(build(stale), HEADER_SIZE, PLUGIN_SIZE),
    ).to.equal(undefined);
  });

  it('decodes Some fee_config from discriminator + 64 payload bytes', () => {
    const trailing = Buffer.concat([
      DISCRIMINATOR,
      FEE_PROGRAM.toBuffer(),
      FEE_ACCOUNT.toBuffer(),
    ]);
    const decoded: SealevelTokenFeeConfig | undefined = decodeTrailingFeeConfig(
      build(trailing),
      HEADER_SIZE,
      PLUGIN_SIZE,
    );
    expect(decoded?.feeProgram.toBase58()).to.equal(FEE_PROGRAM.toBase58());
    expect(decoded?.feeAccount.toBase58()).to.equal(FEE_ACCOUNT.toBase58());
  });

  it('decodes Some even when stale bytes trail the payload', () => {
    const trailing = Buffer.concat([
      DISCRIMINATOR,
      FEE_PROGRAM.toBuffer(),
      FEE_ACCOUNT.toBuffer(),
      Buffer.alloc(16, 0xcc), // stale over-allocated tail
    ]);
    const decoded = decodeTrailingFeeConfig(
      build(trailing),
      HEADER_SIZE,
      PLUGIN_SIZE,
    );
    expect(decoded?.feeProgram.toBase58()).to.equal(FEE_PROGRAM.toBase58());
    expect(decoded?.feeAccount.toBase58()).to.equal(FEE_ACCOUNT.toBase58());
  });

  it('throws on a matching discriminator with a truncated payload', () => {
    const trailing = Buffer.concat([DISCRIMINATOR, Buffer.alloc(40, 0)]);
    expect(() =>
      decodeTrailingFeeConfig(build(trailing), HEADER_SIZE, PLUGIN_SIZE),
    ).to.throw('Truncated fee_config');
  });
});
