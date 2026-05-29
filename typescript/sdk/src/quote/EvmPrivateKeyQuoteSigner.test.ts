import { expect } from 'chai';
import { utils as ethersUtils } from 'ethers';

import { EvmPrivateKeyQuoteSigner } from './EvmPrivateKeyQuoteSigner.js';

// Matches `OffchainQuotedLinearFee.SIGNED_QUOTE_TYPEHASH`:
//   keccak256("SignedQuote(bytes context,bytes data,uint48 issuedAt,uint48 expiry,bytes32 salt,address submitter)")
const SIGNED_QUOTE_TYPES = {
  SignedQuote: [
    { name: 'context', type: 'bytes' },
    { name: 'data', type: 'bytes' },
    { name: 'issuedAt', type: 'uint48' },
    { name: 'expiry', type: 'uint48' },
    { name: 'salt', type: 'bytes32' },
    { name: 'submitter', type: 'address' },
  ],
};

// Anvil test account #1 — public test key, no live funds.
const FIXED_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EXPECTED_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('EvmPrivateKeyQuoteSigner', () => {
  it('exposes the wallet address', async () => {
    const signer = new EvmPrivateKeyQuoteSigner(FIXED_PK);
    expect(await signer.address()).to.equal(EXPECTED_ADDRESS);
  });

  it('signs an EIP-712 SignedQuote payload that recovers to the wallet address', async () => {
    const signer = new EvmPrivateKeyQuoteSigner(FIXED_PK);
    const domain = {
      name: 'OffchainQuoter',
      version: '1',
      chainId: 1,
      verifyingContract: '0x0000000000000000000000000000000000001234',
    };
    const message = {
      context: '0x' + '00'.repeat(68),
      data: '0x' + '00'.repeat(64),
      issuedAt: 1_700_000_000,
      expiry: 1_700_003_600,
      salt: '0x' + '11'.repeat(32),
      submitter: '0x0000000000000000000000000000000000000000',
    };

    const { signature } = await signer.sign({
      domain,
      types: SIGNED_QUOTE_TYPES,
      message,
    });
    expect(signature.length).to.equal(65);

    const recovered = ethersUtils.verifyTypedData(
      domain,
      SIGNED_QUOTE_TYPES,
      message,
      ethersUtils.hexlify(signature),
    );
    expect(recovered).to.equal(EXPECTED_ADDRESS);
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
