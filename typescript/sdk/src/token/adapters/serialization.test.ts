import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';

import {
  SealevelTokenFeeConfig,
  decodeTrailingFeeConfig,
} from './serialization.js';

describe('decodeTrailingFeeConfig', () => {
  const HEADER_SIZE = 50;
  const PLUGIN_SIZE = 98;
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

  it('returns undefined for explicit None (lone 0u8 trailing)', () => {
    expect(
      decodeTrailingFeeConfig(
        build(Buffer.from([0])),
        HEADER_SIZE,
        PLUGIN_SIZE,
      ),
    ).to.equal(undefined);
  });

  it('decodes Some fee_config from 65 trailing bytes', () => {
    const trailing = Buffer.concat([
      Buffer.from([1]),
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

  it('throws on invalid Option tag', () => {
    expect(() =>
      decodeTrailingFeeConfig(
        build(Buffer.from([5])),
        HEADER_SIZE,
        PLUGIN_SIZE,
      ),
    ).to.throw('Invalid fee_config Option tag: 5');
  });

  it('throws on truncated Some payload', () => {
    const trailing = Buffer.concat([Buffer.from([1]), Buffer.alloc(40, 0)]);
    expect(() =>
      decodeTrailingFeeConfig(build(trailing), HEADER_SIZE, PLUGIN_SIZE),
    ).to.throw('Truncated fee_config');
  });
});
