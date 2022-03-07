import { ethers } from 'hardhat';
import { BytesLike } from 'ethers';
import { expect } from 'chai';
import { utils } from '@abacus-network/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import * as types from './lib/types';
import { serializeMessage } from './lib/utils';
import { BridgeDeployment } from './lib/BridgeDeployment';
import { AbacusDeployment } from '@abacus-network/abacus-sol/test';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];

describe('EthHelper', async () => {
  let abacus: AbacusDeployment;
  let bridge: BridgeDeployment;

  let deployer: SignerWithAddress;
  let deployerId: string;

  let recipient: SignerWithAddress;
  let recipientId: string;

  let transferToSelfMessage: BytesLike;
  let transferMessage: BytesLike;

  const value = 1;

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
    deployerId = utils.addressToBytes32(deployer.address);
    recipientId = utils.addressToBytes32(recipient.address);
    abacus = await AbacusDeployment.fromDomains(domains, deployer);
    bridge = await BridgeDeployment.fromAbacusDeployment(abacus, deployer);

    const tokenId: types.TokenIdentifier = {
      domain: localDomain,
      id: utils.addressToBytes32(bridge.weth(localDomain).address),
    };
    const transferToSelfMessageObj: types.Message = {
      tokenId,
      action: {
        type: types.BridgeMessageTypes.TRANSFER,
        recipient: deployerId,
        amount: value,
      },
    };
    transferToSelfMessage = serializeMessage(transferToSelfMessageObj);

    const transferMessageObj: types.Message = {
      tokenId,
      action: {
        type: types.BridgeMessageTypes.TRANSFER,
        recipient: recipientId,
        amount: value,
      },
    };
    transferMessage = serializeMessage(transferMessageObj);
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
