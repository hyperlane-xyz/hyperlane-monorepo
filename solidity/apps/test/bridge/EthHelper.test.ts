import { ethers, abacus } from 'hardhat';
import { expect } from 'chai';
import { ContractTransaction } from 'ethers';
import { utils } from '@abacus-network/utils';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import { BridgeDeploy } from './lib/BridgeDeploy';
import { InterchainGasPaymaster, Outbox } from '@abacus-network/core';
import { ETHHelper } from '../../types';

const localDomain = 1000;
const remoteDomain = 2000;
const domains = [localDomain, remoteDomain];
const defaultValue = 1_000_000;
const defaultGasPayment = 100_000;
const zeroAddress = '0x0000000000000000000000000000000000000000';

describe('EthHelper', async () => {
  let bridge: BridgeDeploy;
  let outbox: Outbox;
  let interchainGasPaymaster: InterchainGasPaymaster;
  let ethHelper: ETHHelper;

  let deployer: SignerWithAddress;

  let recipient: SignerWithAddress;
  let recipientId: string;

  before(async () => {
    [deployer, recipient] = await ethers.getSigners();
    recipientId = utils.addressToBytes32(recipient.address);
    await abacus.deploy(domains, deployer);
    bridge = new BridgeDeploy(deployer);
    await bridge.deploy(abacus);

    outbox = abacus.outbox(localDomain);
    interchainGasPaymaster = abacus.interchainGasPaymaster(localDomain);
    ethHelper = bridge.helper(localDomain);
  });

  const sendFunctionTests = (
    sendFn: (value: number, gasPayment: number) => Promise<ContractTransaction>,
  ) => {
    it('Deposits the provided value minus the gas payment as WETH', async () => {
      await expect(sendFn(defaultValue, defaultGasPayment))
        .to.emit(bridge.weth(localDomain), 'Transfer')
        .withArgs(
          zeroAddress,
          ethHelper.address,
          defaultValue - defaultGasPayment,
        );
    });

    it("Emits the Outbox's Dispatch event", async () => {
      await expect(sendFn(defaultValue, defaultGasPayment)).to.emit(
        outbox,
        'Dispatch',
      );
    });

    it("Emits the InterchainGasPaymaster's GasPayment event", async () => {
      const leafIndex = await outbox.count();
      await expect(sendFn(defaultValue, defaultGasPayment))
        .to.emit(interchainGasPaymaster, 'GasPayment')
        .withArgs(leafIndex, defaultGasPayment);
    });

    it('Reverts if the gas payment exceeds the total provided value', async () => {
      await expect(sendFn(1, 2)).to.be.revertedWith('value too low');
    });
  };

  describe('#send', () =>
    sendFunctionTests((value: number, gasPayment: number) =>
      ethHelper.send(remoteDomain, gasPayment, {
        value,
      }),
    ));

  describe('#sendTo', () =>
    sendFunctionTests((value: number, gasPayment: number) =>
      ethHelper.sendTo(remoteDomain, recipientId, gasPayment, {
        value,
      }),
    ));

  describe('#sendToEVMLike', () =>
    sendFunctionTests((value: number, gasPayment: number) =>
      ethHelper.sendToEVMLike(remoteDomain, recipient.address, gasPayment, {
        value,
      }),
    ));
});
