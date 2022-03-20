import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';
import { utils } from '@abacus-network/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import { BridgeDeploy } from './lib/BridgeDeploy';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];

describe('EthHelper', async () => {
  let bridge: BridgeDeploy;

  let deployer: SignerWithAddress;

  let recipient: SignerWithAddress;
  let recipientId: string;

  const value = 1;

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
    recipientId = utils.addressToBytes32(recipient.address);
    await abacus.deploy(domains, deployer);
    bridge = new BridgeDeploy(deployer);
    await bridge.deploy(abacus);
  });

  it('send function', async () => {
    let sendTx = bridge.helper(localDomain).send(remoteDomain, {
      value,
    });

    await expect(sendTx).to.emit(abacus.outbox(localDomain), 'Dispatch');
  });

  it('sendTo function', async () => {
    let sendTx = bridge.helper(localDomain).sendTo(remoteDomain, recipientId, {
      value,
    });

    await expect(sendTx).to.emit(abacus.outbox(localDomain), 'Dispatch');
  });

  it('sendToEVMLike function', async () => {
    let sendTx = bridge
      .helper(localDomain)
      .sendToEVMLike(remoteDomain, recipient.address, {
        value,
      });

    await expect(sendTx).to.emit(abacus.outbox(localDomain), 'Dispatch');
  });
});
