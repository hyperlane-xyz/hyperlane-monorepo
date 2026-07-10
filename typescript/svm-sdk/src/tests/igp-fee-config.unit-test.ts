import { expect } from 'chai';
import { describe, it } from 'mocha';

import { decodeIgpAccount } from '../accounts/token.js';
import { ByteCursor, concatBytes, u32le } from '../codecs/binary.js';
import {
  decodeIgpFeeConfig,
  encodeIgpFeeConfig,
  type IgpFeeConfig,
} from '../codecs/igp.js';

const SIGNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SIGNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SIGNER_C = '0xcccccccccccccccccccccccccccccccccccccccc';

const IGP_DISCRIMINATOR = new TextEncoder().encode('IGP_____');
const IGP_FEE_CONFIG_DISCRIMINATOR = new TextEncoder().encode('IGPFEEV1');

function buildIgpAccountRaw(
  trailing: Uint8Array = new Uint8Array(),
): Uint8Array {
  // initialized=1 + discriminator + bumpSeed=255 + salt(32 zeros)
  // + owner=None + beneficiary(32 zeros) + gasOracles map (len=0) + trailing
  return Uint8Array.from(
    concatBytes(
      new Uint8Array([1]),
      IGP_DISCRIMINATOR,
      new Uint8Array([255]),
      new Uint8Array(32),
      new Uint8Array([0]),
      new Uint8Array(32),
      u32le(0),
      trailing,
    ),
  );
}

describe('IgpFeeConfig codec', () => {
  it('round-trips a populated config', () => {
    const config: IgpFeeConfig = {
      signers: [SIGNER_A, SIGNER_B],
      domainId: 1234,
      minIssuedAt: 1_700_000_000n,
    };
    const decoded = decodeIgpFeeConfig(
      new ByteCursor(encodeIgpFeeConfig(config)),
    );
    expect(decoded.signers).to.eql(config.signers);
    expect(decoded.domainId).to.equal(config.domainId);
    expect(decoded.minIssuedAt).to.equal(config.minIssuedAt);
  });

  it('round-trips an empty signer set', () => {
    const decoded = decodeIgpFeeConfig(
      new ByteCursor(
        encodeIgpFeeConfig({ signers: [], domainId: 0, minIssuedAt: 0n }),
      ),
    );
    expect(decoded.signers).to.have.length(0);
  });

  it('round-trips a negative minIssuedAt (i64 sign handling)', () => {
    const decoded = decodeIgpFeeConfig(
      new ByteCursor(
        encodeIgpFeeConfig({ signers: [], domainId: 0, minIssuedAt: -1n }),
      ),
    );
    expect(decoded.minIssuedAt).to.equal(-1n);
  });

  it('encoder sorts unsorted signers (BTreeSet canonical order)', () => {
    const decoded = decodeIgpFeeConfig(
      new ByteCursor(
        encodeIgpFeeConfig({
          signers: [SIGNER_C, SIGNER_A, SIGNER_B],
          domainId: 0,
          minIssuedAt: 0n,
        }),
      ),
    );
    expect(decoded.signers).to.eql([SIGNER_A, SIGNER_B, SIGNER_C]);
  });

  it('encoder dedups duplicate signers', () => {
    const decoded = decodeIgpFeeConfig(
      new ByteCursor(
        encodeIgpFeeConfig({
          signers: [SIGNER_A, SIGNER_A, SIGNER_B, SIGNER_B],
          domainId: 0,
          minIssuedAt: 0n,
        }),
      ),
    );
    expect(decoded.signers).to.eql([SIGNER_A, SIGNER_B]);
  });
});

describe('decodeIgpAccount — feeConfig trailing', () => {
  it('returns feeConfig undefined when there are no trailing bytes', () => {
    const decoded = decodeIgpAccount(buildIgpAccountRaw());
    expect(decoded?.feeConfig).to.be.undefined;
  });

  it('returns feeConfig undefined when the trailing tail is shorter than the discriminator', () => {
    const decoded = decodeIgpAccount(buildIgpAccountRaw(new Uint8Array([0])));
    expect(decoded?.feeConfig).to.be.undefined;
  });

  it('parses feeConfig when the IGPFEEV1 discriminator is present', () => {
    const config: IgpFeeConfig = {
      signers: [SIGNER_A],
      domainId: 42,
      minIssuedAt: 9000n,
    };
    const trailing = Uint8Array.from(
      concatBytes(IGP_FEE_CONFIG_DISCRIMINATOR, encodeIgpFeeConfig(config)),
    );
    const decoded = decodeIgpAccount(buildIgpAccountRaw(trailing));
    expect(decoded?.feeConfig?.domainId).to.equal(42);
    expect(decoded?.feeConfig?.minIssuedAt).to.equal(9000n);
    expect(decoded?.feeConfig?.signers).to.eql([SIGNER_A]);
  });

  it('returns feeConfig undefined on a non-matching (stale) 8-byte tail', () => {
    const decoded = decodeIgpAccount(
      buildIgpAccountRaw(new Uint8Array(8).fill(0xff)),
    );
    expect(decoded?.feeConfig).to.be.undefined;
  });
});
