import { ethers, abacus } from 'hardhat';
import { BytesLike } from 'ethers';
import { expect } from 'chai';

import * as types from './lib/types';
import { serializeMessage } from './lib/utils';
import { BridgeConfig, BridgeDeploy } from './lib/BridgeDeploy';
import { types as testTypes, utils } from '@abacus-network/abacus-sol/test';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];

describe('EthHelper', async () => {
  let bridge: BridgeDeploy;

  let deployer: testTypes.Signer;
  let deployerAddress: string;
  let deployerId: string;

  let recipient: testTypes.Signer;
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
    await abacus.init(domains, deployer);
    const config: BridgeConfig = {
      signer: deployer,
      connectionManager: {},
    };
    abacus.domains.map((domain) => {
      config.connectionManager[domain] =
        abacus.xAppConnectionManager(domain).address;
    });
    bridge = new BridgeDeploy();
    await bridge.deploy(abacus.chains, config);

    const tokenId: types.TokenIdentifier = {
      domain: localDomain,
      id: utils.toBytes32(bridge.weth(localDomain).address),
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
    console.log(await bridge.helper(localDomain).bridge(), bridge.router(localDomain).address, await bridge.router(remoteDomain).routers(localDomain));
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
      .sendToEVMLike(remoteDomain, recipientAddress, {
        value,
      });

    await expect(sendTx).to.emit(abacus.outbox(localDomain), 'Dispatch');
  });
});
