import { expect } from 'chai';

import { ALEO_PROGRAMS } from '../programs.js';

import {
  bytes32ToU128String,
  bytesLeToU128String,
  getProgramSuffix,
} from './helper.js';

describe('getProgramSuffix', () => {
  it('uses the generated program metadata', () => {
    expect(ALEO_PROGRAMS).to.include('mailbox');
    expect(getProgramSuffix('hyp_mailbox_abc123.aleo')).to.equal('abc123');
  });

  it('removes the testnet prefix', () => {
    expect(getProgramSuffix('test_hyp_mailbox_abc123.aleo')).to.equal('abc123');
  });
});

describe('u128 byte encoding', () => {
  it('encodes little-endian bytes without the Provable runtime', () => {
    expect(bytesLeToU128String(Uint8Array.from([1, 1]))).to.equal('257u128');
    expect(bytesLeToU128String(new Uint8Array(16).fill(255))).to.equal(
      '340282366920938463463374607431768211455u128',
    );
  });

  it('splits bytes32 values into little-endian u128 pairs', () => {
    expect(
      bytes32ToU128String(
        '0x0101000000000000000000000000000002000000000000000000000000000000',
      ),
    ).to.equal('[257u128,2u128]');
  });
});
