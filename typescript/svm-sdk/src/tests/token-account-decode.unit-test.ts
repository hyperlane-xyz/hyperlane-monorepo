import { address, getAddressEncoder } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { assert } from '@hyperlane-xyz/utils';

import {
  decodeHyperlaneTokenAccount,
  NATIVE_PLUGIN_SIZE,
  type TokenFeeConfig,
} from '../accounts/token.js';
import { concatBytes, u32le, u8 } from '../codecs/binary.js';

const ADDRESS_ENCODER = getAddressEncoder();

const MAILBOX = address('11111111111111111111111111111112');
const PROCESS_AUTHORITY = address('11111111111111111111111111111113');
const FEE_PROGRAM = address('11111111111111111111111111111114');
const FEE_ACCOUNT = address('11111111111111111111111111111115');

const FEE_DISCRIMINATOR = Uint8Array.from('TOKFEEV1', (char) =>
  char.charCodeAt(0),
);
const FEE_PAYLOAD = concatBytes(
  ADDRESS_ENCODER.encode(FEE_PROGRAM),
  ADDRESS_ENCODER.encode(FEE_ACCOUNT),
);

const PLUGIN_DATA = new Uint8Array(NATIVE_PLUGIN_SIZE).fill(7);

function buildTokenAccountBytes(tail: Uint8Array): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      u8(1), // AccountData initialized flag
      u8(255), // bump
      ADDRESS_ENCODER.encode(MAILBOX),
      ADDRESS_ENCODER.encode(PROCESS_AUTHORITY),
      u8(254), // dispatchAuthorityBump
      u8(9), // decimals
      u8(18), // remoteDecimals
      u8(0), // owner: None
      u8(0), // interchainSecurityModule: None
      u8(0), // interchainGasPaymaster: None
      u32le(0), // destinationGas: empty
      u32le(0), // remoteRouters: empty
      PLUGIN_DATA,
      tail,
    ),
  );
}

interface DecodeCase {
  name: string;
  tail: Uint8Array;
  expectedFeeConfig: TokenFeeConfig | null;
}

const cases: DecodeCase[] = [
  {
    name: 'no trailing bytes (pre-fee account)',
    tail: new Uint8Array(0),
    expectedFeeConfig: null,
  },
  {
    name: 'TOKFEEV1 discriminator with full payload',
    tail: Uint8Array.from(concatBytes(FEE_DISCRIMINATOR, FEE_PAYLOAD)),
    expectedFeeConfig: { feeProgram: FEE_PROGRAM, feeAccount: FEE_ACCOUNT },
  },
  {
    name: 'short garbage tail (< 8 bytes)',
    tail: Uint8Array.from([0xff, 0x01, 0x02, 0x03, 0x04]),
    expectedFeeConfig: null,
  },
  {
    name: 'stale tail without discriminator',
    tail: new Uint8Array(16).fill(0xff),
    expectedFeeConfig: null,
  },
  {
    name: 'full payload followed by extra trailing bytes',
    tail: Uint8Array.from(
      concatBytes(FEE_DISCRIMINATOR, FEE_PAYLOAD, new Uint8Array(4).fill(0xaa)),
    ),
    expectedFeeConfig: { feeProgram: FEE_PROGRAM, feeAccount: FEE_ACCOUNT },
  },
];

describe('decodeHyperlaneTokenAccount — trailing fee_config', () => {
  for (const { name, tail, expectedFeeConfig } of cases) {
    it(`${name}: feeConfig ${expectedFeeConfig ? 'parsed' : 'null'}`, () => {
      const decoded = decodeHyperlaneTokenAccount(
        buildTokenAccountBytes(tail),
        NATIVE_PLUGIN_SIZE,
      );
      assert(decoded, 'expected token account to decode');
      expect(decoded.feeConfig).to.deep.equal(expectedFeeConfig);
    });
  }

  it('throws on TOKFEEV1 discriminator with truncated payload', () => {
    const bytes = buildTokenAccountBytes(
      Uint8Array.from(
        concatBytes(FEE_DISCRIMINATOR, new Uint8Array(10).fill(1)),
      ),
    );
    expect(() =>
      decodeHyperlaneTokenAccount(bytes, NATIVE_PLUGIN_SIZE),
    ).to.throw('Buffer underflow');
  });

  it('decodes base fields alongside the fee config tail', () => {
    const decoded = decodeHyperlaneTokenAccount(
      buildTokenAccountBytes(
        Uint8Array.from(concatBytes(FEE_DISCRIMINATOR, FEE_PAYLOAD)),
      ),
      NATIVE_PLUGIN_SIZE,
    );
    assert(decoded, 'expected token account to decode');
    expect(decoded.bump).to.equal(255);
    expect(decoded.mailbox).to.equal(MAILBOX);
    expect(decoded.mailboxProcessAuthority).to.equal(PROCESS_AUTHORITY);
    expect(decoded.dispatchAuthorityBump).to.equal(254);
    expect(decoded.decimals).to.equal(9);
    expect(decoded.remoteDecimals).to.equal(18);
    expect(decoded.owner).to.equal(null);
    expect(decoded.interchainSecurityModule).to.equal(null);
    expect(decoded.interchainGasPaymaster).to.equal(null);
    expect(decoded.destinationGas.size).to.equal(0);
    expect(decoded.remoteRouters.size).to.equal(0);
    expect(decoded.pluginData).to.deep.equal(PLUGIN_DATA);
  });
});
