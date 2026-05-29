import { secp256k1 } from '@noble/curves/secp256k1';
import { address as parseAddress } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { describe, it } from 'mocha';

import { u48be } from '../codecs/binary.js';
import {
  buildSvmQuoteMessageHash,
  ethAddressHexFromPrivateKey,
} from '../quote-signing.js';

import { SvmPrivateKeyQuoteSigner } from './SvmPrivateKeyQuoteSigner.js';
import { type SvmQuoteSignable } from './SvmQuoteSignable.js';

chai.use(chaiAsPromised);

const TEST_PK = secp256k1.utils.randomSecretKey();
const EXPECTED_ADDRESS = ethAddressHexFromPrivateKey(TEST_PK);

const FEE_ACCOUNT = '11111111111111111111111111111111';
const DOMAIN_ID = 1399811149;

function makeSignable(
  overrides: Partial<SvmQuoteSignable> = {},
): SvmQuoteSignable {
  return {
    feeAccount: FEE_ACCOUNT,
    domainId: DOMAIN_ID,
    context: new Uint8Array(44),
    data: new Uint8Array(32),
    issuedAt: 1_700_000_000,
    expiry: 1_700_003_600,
    scopedSalt: new Uint8Array(32),
    ...overrides,
  };
}

function buildExpectedDigest(s: SvmQuoteSignable): Uint8Array {
  return buildSvmQuoteMessageHash({
    feeAccount: parseAddress(s.feeAccount),
    domainId: s.domainId,
    context: s.context,
    data: s.data,
    issuedAt: u48be(BigInt(s.issuedAt)),
    expiry: u48be(BigInt(s.expiry)),
    scopedSalt: s.scopedSalt,
  });
}

describe('SvmPrivateKeyQuoteSigner', () => {
  it('exposes the H160 eth-style address derived from the secp256k1 PK', async () => {
    const signer = new SvmPrivateKeyQuoteSigner(TEST_PK);
    expect(await signer.address()).to.equal(EXPECTED_ADDRESS);
  });

  it('signs an SvmQuoteSignable and the signature recovers to the same public key', async () => {
    const signer = new SvmPrivateKeyQuoteSigner(TEST_PK);
    const signable = makeSignable();
    const { signature } = await signer.sign(signable);
    expect(signature.length).to.equal(65);

    const sig = secp256k1.Signature.fromBytes(
      signature.slice(0, 64),
      'compact',
    ).addRecoveryBit(signature[64]);
    const digest = buildExpectedDigest(signable);
    const recoveredPub = sig.recoverPublicKey(digest).toBytes(false);
    const expectedPub = secp256k1.getPublicKey(TEST_PK, false);
    expect(recoveredPub).to.deep.equal(expectedPub);
  });

  it('throws when the input is not an SvmQuoteSignable', async () => {
    const signer = new SvmPrivateKeyQuoteSigner(TEST_PK);
    await expect(signer.sign({ not: 'a signable' })).to.be.rejectedWith(
      /SVM quote signable/,
    );
  });

  it('throws when the private key is not 32 bytes', () => {
    expect(() => new SvmPrivateKeyQuoteSigner(new Uint8Array(16))).to.throw(
      /must be 32 bytes/,
    );
  });
});
