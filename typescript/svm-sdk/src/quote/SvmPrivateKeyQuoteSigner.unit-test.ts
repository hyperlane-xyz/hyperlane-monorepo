import { secp256k1 } from '@noble/curves/secp256k1';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { describe, it } from 'mocha';

import { ethAddressHexFromPrivateKey } from '../quote-signing.js';

import { SvmPrivateKeyQuoteSigner } from './SvmPrivateKeyQuoteSigner.js';

chai.use(chaiAsPromised);

const TEST_PK = secp256k1.utils.randomSecretKey();
const EXPECTED_ADDRESS = ethAddressHexFromPrivateKey(TEST_PK);

describe('SvmPrivateKeyQuoteSigner', () => {
  it('exposes the H160 eth-style address derived from the secp256k1 PK', async () => {
    const signer = new SvmPrivateKeyQuoteSigner(TEST_PK);
    expect(await signer.address()).to.equal(EXPECTED_ADDRESS);
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
