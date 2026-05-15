import { expect } from 'chai';

import {
  SealevelIgpFeeConfig,
  decodeTrailingIgpFeeConfig,
} from './serialization.js';

describe('decodeTrailingIgpFeeConfig', () => {
  const CONSUMED = 80;

  function build(trailing: Buffer | null): Buffer {
    const header = Buffer.alloc(CONSUMED, 0xff);
    return trailing ? Buffer.concat([header, trailing]) : header;
  }

  it('returns undefined for pre-upgrade accounts (no trailing bytes)', () => {
    expect(decodeTrailingIgpFeeConfig(build(null), CONSUMED)).to.equal(
      undefined,
    );
  });

  it('returns undefined for explicit None (lone 0u8 trailing)', () => {
    expect(
      decodeTrailingIgpFeeConfig(build(Buffer.from([0])), CONSUMED),
    ).to.equal(undefined);
  });

  it('decodes Some with multiple signers', () => {
    const signer1 = Buffer.alloc(20, 0x11);
    const signer2 = Buffer.alloc(20, 0x22);
    const trailing = Buffer.concat([
      Buffer.from([1]), // Option tag
      Buffer.from([0x02, 0x00, 0x00, 0x00]), // 2 signers (u32 LE)
      signer1,
      signer2,
      Buffer.from([0x39, 0x05, 0x00, 0x00]), // domain_id = 1337
      Buffer.from([0xd2, 0x02, 0x96, 0x49, 0x00, 0x00, 0x00, 0x00]), // min_issued_at = 1234567890
    ]);
    const decoded: SealevelIgpFeeConfig | undefined =
      decodeTrailingIgpFeeConfig(build(trailing), CONSUMED);
    expect(decoded?.signers).to.deep.equal([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ]);
    expect(decoded?.domain_id).to.equal(1337);
    expect(decoded?.min_issued_at).to.equal(1234567890n);
  });

  it('decodes Some with zero signers', () => {
    const trailing = Buffer.concat([
      Buffer.from([1]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // 0 signers
      Buffer.from([0x05, 0x00, 0x00, 0x00]), // domain_id = 5
      Buffer.alloc(8, 0), // min_issued_at = 0
    ]);
    const decoded = decodeTrailingIgpFeeConfig(build(trailing), CONSUMED);
    expect(decoded?.signers).to.deep.equal([]);
    expect(decoded?.domain_id).to.equal(5);
    expect(decoded?.min_issued_at).to.equal(0n);
  });

  it('throws on invalid Option tag', () => {
    expect(() =>
      decodeTrailingIgpFeeConfig(build(Buffer.from([7])), CONSUMED),
    ).to.throw('Invalid igp.fee_config Option tag: 7');
  });

  it('throws on truncated signers length', () => {
    expect(() =>
      decodeTrailingIgpFeeConfig(build(Buffer.from([1, 0x01, 0x00])), CONSUMED),
    ).to.throw('Truncated igp.fee_config');
  });

  it('throws on truncated payload', () => {
    const trailing = Buffer.concat([
      Buffer.from([1]),
      Buffer.from([0x01, 0x00, 0x00, 0x00]), // 1 signer
      Buffer.alloc(20, 0xaa), // signer
      Buffer.from([0x05]), // truncated domain_id
    ]);
    expect(() =>
      decodeTrailingIgpFeeConfig(build(trailing), CONSUMED),
    ).to.throw('Truncated igp.fee_config');
  });
});
