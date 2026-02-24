import { expect } from 'chai';
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { LocalAccountViemSigner } from './local.js';

describe('LocalAccountViemSigner', () => {
  it('supports ethers-compatible _signTypedData', async () => {
    const privateKey = `0x${'11'.repeat(32)}`;
    const signer = new LocalAccountViemSigner(privateKey);
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const domain = {
      chainId: 1,
      name: 'Safe Transaction Service',
      verifyingContract: '0x0000000000000000000000000000000000000001' as const,
      version: '1.0',
    };
    const types = {
      DeleteRequest: [
        { name: 'safeTxHash', type: 'bytes32' },
        { name: 'totp', type: 'uint256' },
      ],
    } as const;
    const value = {
      safeTxHash: `0x${'22'.repeat(32)}` as const,
      totp: 1n,
    };

    const signature = await signer._signTypedData(domain, types, value);
    expect(signature).to.match(/^0x[0-9a-fA-F]{130}$/);

    const isValid = await verifyTypedData({
      address: account.address,
      domain,
      types,
      primaryType: 'DeleteRequest',
      message: value,
      signature,
    });
    expect(isValid).to.equal(true);
  });
});
