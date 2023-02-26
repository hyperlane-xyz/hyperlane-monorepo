import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { types } from '@hyperlane-xyz/utils';

import { Chains } from '../consts/chains';
import { HyperlaneCore } from '../core/HyperlaneCore';
import { TestCoreDeployer } from '../core/TestCoreDeployer';
import { MultiProvider } from '../providers/MultiProvider';

import { InterchainGasCalculator } from './calculator';

describe('InterchainGasCalculator', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;

  const testGasAmount = BigNumber.from('100000');

  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;

  let calculator: InterchainGasCalculator;
  let igp: types.Address;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    const core = new HyperlaneCore(coreContractsMaps, multiProvider);
    calculator = new InterchainGasCalculator(multiProvider, core);
    igp = coreContractsMaps[localChain].interchainGasPaymaster.address;
  });

  describe('quoteGasPaymentForDefaultIsmIgp', () => {
    it("calls the default ISM IGP's quoteGasPayment function", async () => {
      const quote = await calculator.quoteGasPaymentForDefaultIsmIgp(
        localChain,
        remoteChain,
        testGasAmount,
      );

      // (100,000 gas amount + 151,966 overhead) * 10 gas price
      expect(quote).to.equal(BigNumber.from('2519660'));
    });
  });

  describe('quoteGasPayment', () => {
    it("calls the IGP's quoteGasPayment function", async () => {
      const quote = await calculator.quoteGasPayment(
        localChain,
        remoteChain,
        testGasAmount,
      );

      // 100,000 gas amount * 10 gas price
      expect(quote).to.equal(BigNumber.from('1000000'));
    });
  });

  describe('quoteGasPaymentForIGP', () => {
    it("calls the provided IGP's quoteGasPayment", async () => {
      const quote = await calculator.quoteGasPaymentForIGP(
        localChain,
        remoteChain,
        testGasAmount,
        igp,
      );

      // 100,000 gas amount * 10 gas price
      expect(quote).to.equal(BigNumber.from('1000000'));
    });
  });
});
