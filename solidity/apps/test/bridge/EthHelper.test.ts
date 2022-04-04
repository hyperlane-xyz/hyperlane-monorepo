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

describe.only('EthHelper', async () => {
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

  // Used to test all send, sendTo, and sendToEvmLike functions and their
  // interchain gas paying versions to avoid code duplication
  const testSendFunction = (
    sendFn: (value: number) => Promise<ContractTransaction>,
  ) => {
    it("Emits the Outbox's Dispatch event", async () => {
      await expect(sendFn(defaultValue)).to.emit(outbox, 'Dispatch');
    });
  };

  // Used to test all interchain gas paying functions: sendWithGas, sendToWithGas,
  // and sendToEvmLikeWithGas to avoid code duplication
  const testSendWithGasFunction = (
    sendFn: (value: number, gasPayment: number) => Promise<ContractTransaction>,
  ) => {
    it('Deposits the provided value minus the gas payment as WETH', async () => {
      await expect(sendFn(defaultValue, defaultGasPayment))
        .to.emit(bridge.weth(localDomain), 'Transfer')
        .withArgs(
          ethers.constants.AddressZero,
          ethHelper.address,
          defaultValue - defaultGasPayment,
        );
    });

    it('Pays for interchain gas with the provided gas payment amount', async () => {
      const leafIndex = await outbox.count();
      await expect(sendFn(defaultValue, defaultGasPayment))
        .to.emit(interchainGasPaymaster, 'GasPayment')
        .withArgs(leafIndex, defaultGasPayment);
    });

    it('Reverts if the gas payment exceeds the total provided value', async () => {
      await expect(sendFn(1, 2)).to.be.revertedWith('value too low');
    });

    // Run tests that aren't specific to interchain gas payment
    testSendFunction((value: number) => sendFn(value, defaultGasPayment));
  };

  // Functions that do not attempt to pay for interchain gas
  describe('non-interchain gas paying functions', () => {
    describe('#send', () =>
      testSendFunction((value: number) =>
        ethHelper.send(remoteDomain, {
          value,
        }),
      ));

    describe('#sendTo', () =>
      testSendFunction((value: number) =>
        ethHelper.sendTo(remoteDomain, recipientId, {
          value,
        }),
      ));

    describe('#sendToEVMLike', () =>
      testSendFunction((value: number) =>
        ethHelper.sendToEVMLike(remoteDomain, recipient.address, {
          value,
        }),
      ));
  });

  // Functions that do pay interchain gas
  describe('interchain gas paying functions', () => {
    describe('#sendWithGas', () =>
      testSendWithGasFunction((value: number, gasPayment: number) =>
        ethHelper.sendWithGas(remoteDomain, gasPayment, {
          value,
        }),
      ));

    describe('#sendToWithGas', () =>
      testSendWithGasFunction((value: number, gasPayment: number) =>
        ethHelper.sendToWithGas(remoteDomain, recipientId, gasPayment, {
          value,
        }),
      ));

    describe('#sendToEVMLikeWithGas', () =>
      testSendWithGasFunction((value: number, gasPayment: number) =>
        ethHelper.sendToEVMLikeWithGas(
          remoteDomain,
          recipient.address,
          gasPayment,
          {
            value,
          },
        ),
      ));
  });
});
