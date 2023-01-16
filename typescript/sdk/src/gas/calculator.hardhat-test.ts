import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import { types } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../core/HyperlaneCore';
import { TestCoreDeployer } from '../core/TestCoreDeployer';
import { getTestMultiProvider } from '../deploy/utils';
import { MultiProvider } from '../providers/MultiProvider';
import { TestChainNames } from '../types';

import { InterchainGasCalculator } from './calculator';

describe('InterchainGasCalculator', async () => {
  const localChain = 'test1';
  const remoteChain = 'test2';

  const expectedDefaultQuote = BigNumber.from('1');
  const testGasAmount = BigNumber.from('100000');

  let signer: SignerWithAddress;
  let multiProvider: MultiProvider<TestChainNames>;

  let calculator: InterchainGasCalculator<TestChainNames>;
  let localDefaultIGP: types.Address;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = getTestMultiProvider(signer);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    const core = new HyperlaneCore(coreContractsMaps, multiProvider);
    calculator = new InterchainGasCalculator(multiProvider, core);
    localDefaultIGP =
      coreContractsMaps[localChain].interchainGasPaymaster.address;
  });

  describe('quoteGasPayment', () => {
    it('calls the default IGP.quoteGasPayment', async () => {
      const quote = await calculator.quoteGasPayment(
        localChain,
        remoteChain,
        testGasAmount,
      );

      expect(quote).to.equal(expectedDefaultQuote);
    });
  });

  describe('quoteGasPaymentForIGP', () => {
    it('calls the IGP.quoteGasPayment', async () => {
      const quote = await calculator.quoteGasPaymentForIGP(
        localChain,
        remoteChain,
        testGasAmount,
        localDefaultIGP,
      );

      expect(quote).to.equal(expectedDefaultQuote);
    });

    // Temporary kludge until IGPs all implement quoteGasPayment
    it('defaults to zero if IGP.quoteGasPayment reverts', async () => {
      const expectedQuote = BigNumber.from('0');

      const quote = await calculator.quoteGasPaymentForIGP(
        localChain,
        remoteChain,
        testGasAmount,
        '0xdead00000000000000000000000000000000dead',
      );

      expect(quote).to.equal(expectedQuote);
    });
  });
});
