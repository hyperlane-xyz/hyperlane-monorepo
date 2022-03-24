import { ethers } from 'hardhat';

import { BadRandomRecipient__factory } from '../types';
import { utils } from '@abacus-network/utils';
import { expect } from 'chai';

describe('BadRecipient', () => {
  describe('RandomBadRecipient', () => {
    it('randomly handles a message', async () => {
      const [signer] = await ethers.getSigners();
      const signerAddress = await signer.getAddress();
      const recipientFactory = new BadRandomRecipient__factory(signer);
      const recipient = await recipientFactory.deploy();

      // Didn't know how else to test the randomness
      let successes = 0;
      let failures = 0;
      for (let i = 0; i < 10; i++) {
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

      expect(successes).to.be.greaterThan(1);
      expect(failures).to.be.greaterThan(1);
    });
  });
});
