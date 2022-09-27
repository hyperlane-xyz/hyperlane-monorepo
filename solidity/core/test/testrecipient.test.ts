import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import { TestRecipient__factory } from '../types';

const testData = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('test'));
describe('TestRecipient', () => {
  it('handles a message', async () => {
    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();
    const recipientFactory = new TestRecipient__factory(signer);
    const recipient = await recipientFactory.deploy();

    await expect(
      recipient.handle(0, utils.addressToBytes32(signerAddress), testData),
    ).to.emit(recipient, 'ReceivedMessage');
    expect(await recipient.lastSender()).to.eql(
      utils.addressToBytes32(signerAddress),
    );
    expect(await recipient.lastData()).to.eql(testData);
  });

  it('handles a call', async () => {
    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();
    const recipientFactory = new TestRecipient__factory(signer);
    const recipient = await recipientFactory.deploy();

    await expect(
      recipient.handleCall(
        ethers.utils.hexlify(ethers.utils.toUtf8Bytes('test')),
      ),
    ).to.emit(recipient, 'ReceivedCall');

    expect(await recipient.lastCaller()).to.eql(signerAddress);
    expect(await recipient.lastCalldata()).to.eql(testData);
  });
});
