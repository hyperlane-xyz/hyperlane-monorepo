import { ethers } from 'hardhat';
import { BytesLike, Signer } from 'ethers';
import { expect } from 'chai';

import * as types from './lib/types';
import { serializeMessage } from './lib/utils';
import { BridgeDeployment } from './lib/BridgeDeployment';
import { AbacusDeployment, utils } from '@abacus-network/abacus-sol/test';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];

describe('EthHelper', async () => {
  let abacusDeployment: AbacusDeployment;
  let bridgeDeployment: BridgeDeployment;

  let deployer: Signer;
  let deployerAddress: string;
  let deployerId: string;

  let recipient: Signer;
  let recipientAddress: string;
  let recipientId: string;

  let transferToSelfMessage: BytesLike;
  let transferMessage: BytesLike;

  const value = 1;

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    deployerId = utils.toBytes32(deployerAddress).toLowerCase();
    recipientAddress = await recipient.getAddress();
    recipientId = utils.toBytes32(recipientAddress).toLowerCase();
    abacusDeployment = await AbacusDeployment.fromDomains(domains, deployer);
    bridgeDeployment = await BridgeDeployment.fromAbacusDeployment(
      abacusDeployment,
      deployer,
    );

    const tokenId: types.TokenIdentifier = {
      domain: localDomain,
      id: utils.toBytes32(bridgeDeployment.weth(localDomain).address),
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
    let sendTx = bridgeDeployment.helper(localDomain).send(remoteDomain, {
      value,
    });

    await expect(sendTx).to.emit(
      abacusDeployment.outbox(localDomain),
      'Dispatch',
    );
  });

  it('sendTo function', async () => {
    let sendTx = bridgeDeployment
      .helper(localDomain)
      .sendTo(remoteDomain, recipientId, {
        value,
      });

    await expect(sendTx).to.emit(
      abacusDeployment.outbox(localDomain),
      'Dispatch',
    );
  });

  it('sendToEVMLike function', async () => {
    let sendTx = bridgeDeployment
      .helper(localDomain)
      .sendToEVMLike(remoteDomain, recipientAddress, {
        value,
      });

    await expect(sendTx).to.emit(
      abacusDeployment.outbox(localDomain),
      'Dispatch',
    );
  });
});
