import { expect } from 'chai';

import { EvmPrivateKeyQuoteSigner } from './EvmPrivateKeyQuoteSigner.js';

// Anvil test account #1 — public test key, no live funds.
const FIXED_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EXPECTED_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('EvmPrivateKeyQuoteSigner', () => {
  it('exposes the wallet address', async () => {
    const signer = new EvmPrivateKeyQuoteSigner(FIXED_PK);
    expect(await signer.address()).to.equal(EXPECTED_ADDRESS);
  });

  it('throws when the input is not an EIP-712 envelope', async () => {
    const signer = new EvmPrivateKeyQuoteSigner(FIXED_PK);
    let threw = false;
    try {
      await signer.sign({ not: 'a signable' });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
