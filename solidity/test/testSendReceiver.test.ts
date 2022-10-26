import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import { TestSendReceiver__factory } from '../types';

describe('TestSendReceiver', () => {
  it('randomly handles a message', async () => {
    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();
    const recipientFactory = new TestSendReceiver__factory(signer);
    const recipient = await recipientFactory.deploy();

    // Didn't know how else to test the randomness
    let successes = 0;
    let failures = 0;
    for (let i = 0; i < 100; i++) {
      try {
        // "Inject randomness"
        await signer.sendTransaction({
          from: signerAddress,
          to: signerAddress,
          value: 1,
        });
        await recipient.handle(
          0,
          utils.addressToBytes32(recipient.address),
          '0x1234',
        );
        successes += 1;
      } catch (error) {
        failures += 1;
      }
    }

    expect(successes).to.be.greaterThan(5);
    expect(failures).to.be.greaterThan(5);
  });
});
