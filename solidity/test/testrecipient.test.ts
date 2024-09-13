import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import { expect } from 'chai';
import { utils } from 'ethers';
import hre from 'hardhat';
import { Provider, Wallet } from 'zksync-ethers';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { TestRecipient, TestRecipient__factory } from '../types';

import { getSigner } from './signer';

const testData = utils.hexlify(utils.toUtf8Bytes('test'));
describe('TestRecipient', () => {
  let recipient: any;
  let signerAddress: string;

  before(async () => {
    const provider = new Provider('http://127.0.0.1:8011');

    const deployerWallet = new Wallet(
      '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
      provider,
    );
    const deployer = new Deployer(hre, deployerWallet);

    let artifact = await deployer.loadArtifact('TestRecipient');
    recipient = await deployer.deploy(artifact, []);
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
