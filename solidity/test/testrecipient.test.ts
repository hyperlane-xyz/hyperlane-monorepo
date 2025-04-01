import { expect } from 'chai';
import { utils } from 'ethers';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { TestRecipient, TestRecipient__factory } from '../core-utils/typechain';

import { getSigner } from './signer';

const testData = utils.hexlify(utils.toUtf8Bytes('test'));
describe('TestRecipient', () => {
  let recipient: TestRecipient;
  let signerAddress: string;

  before(async () => {
    const signer = await getSigner();
    signerAddress = await signer.getAddress();
    const recipientFactory = new TestRecipient__factory(signer);
    recipient = await recipientFactory.deploy();
  });

  it('handles a message', async () => {
    await expect(
      recipient.handle(0, addressToBytes32(signerAddress), testData),
    ).to.emit(recipient, 'ReceivedMessage');
    expect(await recipient.lastSender()).to.eql(
      addressToBytes32(signerAddress),
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
