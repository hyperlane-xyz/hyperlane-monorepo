import { ethers, bridge, abacus } from 'hardhat';
import { Signer } from 'ethers';
import { expect } from 'chai';

import * as types from './lib/types';
import { toBytes32 } from './lib/utils';
import { BridgeDeployment } from './lib/BridgeDeployment';
import { AbacusDeployment } from '@abacus-network/abacus-sol/test/lib/AbacusDeployment';

const { BridgeMessageTypes } = bridge;
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

  let transferToSelfMessage: string;
  let transferMessage: string;

  const value = 1;

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    deployerId = toBytes32(deployerAddress).toLowerCase();
    recipientAddress = await recipient.getAddress();
    recipientId = toBytes32(recipientAddress).toLowerCase();
    abacusDeployment = await abacus.deployment.fromDomains(domains, deployer);
    bridgeDeployment = await BridgeDeployment.fromAbacusDeployment(
      abacusDeployment,
      deployer,
    );

    const tokenId: types.TokenIdentifier = {
      domain: localDomain,
      id: toBytes32(bridgeDeployment.weth(localDomain).address),
    };
    const transferToSelfMessageObj: types.Message = {
      tokenId,
      action: {
        type: BridgeMessageTypes.TRANSFER,
        recipient: deployerId,
        amount: value,
      },
    };
    transferToSelfMessage = bridge.serializeMessage(transferToSelfMessageObj);

    const transferMessageObj: types.Message = {
      tokenId,
      action: {
        type: BridgeMessageTypes.TRANSFER,
        recipient: recipientId,
        amount: value,
      },
    };
    transferMessage = bridge.serializeMessage(transferMessageObj);
  });

  it('send function', async () => {
    let sendTx = bridgeDeployment.helper(localDomain).send(remoteDomain, {
      value,
    });

    await expect(sendTx).to.emit(
      abacusDeployment.home(localDomain),
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
      abacusDeployment.home(localDomain),
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
      abacusDeployment.home(localDomain),
      'Dispatch',
    );
  });
});
