import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import { expect } from 'chai';
import { utils } from 'ethers';
import hre from 'hardhat';
import { Provider, Wallet } from 'zksync-ethers';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { MockMailbox__factory, TestRecipient__factory } from '../types';

import { getSigner } from './signer';

const ORIGIN_DOMAIN = 1000;
const DESTINATION_DOMAIN = 2000;

describe('MockMailbox', function () {
  it('should be able to mock sending and receiving a message', async function () {
    const provider = new Provider('http://127.0.0.1:8011');

    const deployerWallet = new Wallet(
      '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
      provider,
    );

    const deployer = new Deployer(hre, deployerWallet);

    let artifact = await deployer.loadArtifact('MockMailbox');
    const originMailbox = await deployer.deploy(artifact, [ORIGIN_DOMAIN]);
    const destinationMailbox = await deployer.deploy(artifact, [
      DESTINATION_DOMAIN,
    ]);

    await originMailbox.addRemoteMailbox(
      DESTINATION_DOMAIN,
      destinationMailbox.address,
    );

    artifact = await deployer.loadArtifact('TestRecipient');
    const recipient = await deployer.deploy(artifact, []);

    const body = utils.toUtf8Bytes('This is a test message');

    await originMailbox['dispatch(uint32,bytes32,bytes)'](
      DESTINATION_DOMAIN,
      addressToBytes32(recipient.address),
      body,
    );
    await destinationMailbox.processNextInboundMessage();

    const dataReceived = await recipient.lastData();
    expect(dataReceived).to.eql(utils.hexlify(body));
  });
});
