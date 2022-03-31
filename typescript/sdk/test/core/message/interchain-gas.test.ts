import { formatMessage } from '@abacus-network/utils/dist/src/utils';
import { expect } from 'chai';
import { BigNumber, ethers, FixedNumber } from 'ethers';

import { AbacusCore, InterchainGasPayingMessage } from '../../../src/core';
import { MockProvider, MockTokenPriceGetter, testAddresses } from '../../utils';

describe('InterchainGasPayingMessage', () => {
  const sourceDomain = 1;
  const destinationDomain = 2;

  const testSerializedMessage = formatMessage(
    sourceDomain,
    ethers.constants.AddressZero,
    0,
    destinationDomain,
    ethers.constants.AddressZero,
    '0x12345678',
  );

  let core: AbacusCore;
  let provider: MockProvider;
  let tokenPriceGetter: MockTokenPriceGetter;
  let testMessage: InterchainGasPayingMessage;

  before(() => {
    core = new AbacusCore(testAddresses);
    provider = new MockProvider();
    core.registerProvider('test1', provider);
    core.registerProvider('test2', provider);

    tokenPriceGetter = new MockTokenPriceGetter();
    // Source domain token
    tokenPriceGetter.setTokenPrice(sourceDomain, 10);
    // Destination domain token
    tokenPriceGetter.setTokenPrice(destinationDomain, 5);
  });

  beforeEach(() => {
    testMessage = new InterchainGasPayingMessage(core, testSerializedMessage, {
      tokenPriceGetter,
    });
  });

  afterEach(() => {
    provider.clearMethodResolveValues();
  });

  describe('estimateInterchainGasPayment', () => {
    it('estimates source token payment', async () => {
      // Set the estimated destination gas
      const estimatedDestinationGas = 100_000;
      testMessage.estimateDestinationGas = () => Promise.resolve(ethers.BigNumber.from(estimatedDestinationGas));

      // Set destination gas price to 10 wei
      provider.setMethodResolveValue('getGasPrice', BigNumber.from(10));

      // Set paymentEstimateMultiplier and destinationGasPriceMultiplier to 1 just to test easily
      testMessage.paymentEstimateMultiplier = FixedNumber.from(1);
      testMessage.destinationGasPriceMultiplier = FixedNumber.from(1);

      const estimatedPayment = await testMessage.estimateInterchainGasPayment();

      // 100_000 dest gas * 10 gas price * ($5 per source token / $10 per source token)
      expect(estimatedPayment.toNumber()).to.equal(500_000);
    });
  });

  describe('convertDestinationWeiToSourceWei', () => {
    it('converts using the USD value of source and destination native tokens', async () => {
      const destinationWei = BigNumber.from('1000');
      const sourceWei = await testMessage.convertDestinationWeiToSourceWei(destinationWei);
      
      expect(sourceWei.toNumber()).to.equal(500);
    });

    it('considers when the source token decimals > the destination token decimals', async () => {
      // Hack to mock a getter without something more heavyweight like Jest
      Object.defineProperty(testMessage, 'sourceTokenDecimals', {
        get() {
          return 20;
        }
      });

      const destinationWei = BigNumber.from('1000');
      const sourceWei = await testMessage.convertDestinationWeiToSourceWei(destinationWei);

      expect(sourceWei.toNumber()).to.equal(50000);
    });

    it('considers when the source token decimals < the destination token decimals', async () => {
      // Hack to mock a getter without something more heavyweight like Jest
      Object.defineProperty(testMessage, 'sourceTokenDecimals', {
        get() {
          return 16;
        }
      });

      const destinationWei = BigNumber.from('1000');
      const sourceWei = await testMessage.convertDestinationWeiToSourceWei(destinationWei);

      expect(sourceWei.toNumber()).to.equal(5);
    })
  });

  describe('suggestedDestinationGasPrice', () => {
    it('gets the gas price from the provider', async () => {
      const gasPrice = 1000;
      provider.setMethodResolveValue('getGasPrice', BigNumber.from(gasPrice));

      // Set destinationGasPriceMultiplier to 1 just to test easily
      testMessage.destinationGasPriceMultiplier = FixedNumber.from(1);

      expect(
        (await testMessage.suggestedDestinationGasPrice()).toNumber()
      ).to.equal(gasPrice);
    });
  });
});
