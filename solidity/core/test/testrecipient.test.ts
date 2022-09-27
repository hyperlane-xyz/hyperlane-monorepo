import { expect } from 'chai';
import { ethers } from 'hardhat';

import { utils } from '@hyperlane-xyz/utils';

import { TestRecipient, TestRecipient__factory } from '../types';

const testData = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('test'));
describe('TestRecipient', () => {
  let recipient: TestRecipient;
  let signerAddress: string;

  before(async () => {
    const [signer] = await ethers.getSigners();
    signerAddress = await signer.getAddress();
    const recipientFactory = new TestRecipient__factory(signer);
    recipient = await recipientFactory.deploy();
  });

  it('handles a message', async () => {
    await expect(
      recipient.handle(0, utils.addressToBytes32(signerAddress), testData),
    ).to.emit(recipient, 'ReceivedMessage');
    expect(await recipient.lastSender()).to.eql(
      utils.addressToBytes32(signerAddress),
    );
    expect(await recipient.lastData()).to.eql(testData);
  });

  it('handles a call', async () => {
    await expect(recipient.fooBar(1, 'test')).to.emit(
      recipient,
      'ReceivedCall',
    );

    expect(await recipient.lastCaller()).to.eql(signerAddress);
    expect(await recipient.lastCallMessage()).to.eql('test');
  });
});
