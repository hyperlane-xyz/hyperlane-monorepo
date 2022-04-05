import { expect } from 'chai';
import { BigNumber, FixedNumber } from 'ethers';

import { AbacusCore } from '../../src/core';
import { InterchainGasCalculator } from '../../src/gas/interchain-gas-calculator';
import { MockProvider, MockTokenPriceGetter, testAddresses } from '../utils';

describe('InterchainGasCalculator', () => {
  const sourceDomain = 1;
  const destinationDomain = 2;

  let core: AbacusCore;
  let provider: MockProvider;
  let tokenPriceGetter: MockTokenPriceGetter;
  let calculator: InterchainGasCalculator;

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
    calculator = new InterchainGasCalculator(core, {
      tokenPriceGetter,
    });
  });

  afterEach(() => {
    provider.clearMethodResolveValues();
  });

  describe('estimateGasPayment', () => {
    it('estimates source token payment', async () => {
      const destinationGas = BigNumber.from(100_000);

      // Set destination gas price to 10 wei
      provider.setMethodResolveValue('getGasPrice', BigNumber.from(10));

      // Set paymentEstimateMultiplier and suggestedGasPriceMultiplier to 1 just to test easily
      calculator.paymentEstimateMultiplier = FixedNumber.from(1);
      calculator.suggestedGasPriceMultiplier = FixedNumber.from(1);

      const estimatedPayment = await calculator.estimateGasPayment(
        sourceDomain,
        destinationDomain,
        destinationGas,
      );

      // 100_000 dest gas * 10 gas price * ($5 per source token / $10 per source token)
      expect(estimatedPayment.toNumber()).to.equal(500_000);
    });
  });

  describe('convertDestinationWeiToSourceWei', () => {
    it('converts using the USD value of source and destination native tokens', async () => {
      const destinationWei = BigNumber.from('1000');
      const sourceWei = await calculator.convertDestinationWeiToSourceWei(
        sourceDomain,
        destinationDomain,
        destinationWei,
      );
      
      expect(sourceWei.toNumber()).to.equal(500);
    });

    it('considers when the source token decimals > the destination token decimals', async () => {
      calculator.nativeTokenDecimals = (domain: number) => {
        if (domain === sourceDomain) {
          return 20;
        }
        return 18;
      };

      const destinationWei = BigNumber.from('1000');
      const sourceWei = await calculator.convertDestinationWeiToSourceWei(
        sourceDomain,
        destinationDomain,
        destinationWei,
      );

      expect(sourceWei.toNumber()).to.equal(50000);
    });

    it('considers when the source token decimals < the destination token decimals', async () => {
      calculator.nativeTokenDecimals = (domain: number) => {
        if (domain === sourceDomain) {
          return 16;
        }
        return 18;
      };

      const destinationWei = BigNumber.from('1000');
      const sourceWei = await calculator.convertDestinationWeiToSourceWei(
        sourceDomain,
        destinationDomain,
        destinationWei,
      );

      expect(sourceWei.toNumber()).to.equal(5);
    })
  });

  describe('suggestedDestinationGasPrice', () => {
    it('gets the gas price from the provider', async () => {
      const gasPrice = 1000;
      provider.setMethodResolveValue('getGasPrice', BigNumber.from(gasPrice));

      // Set suggestedGasPriceMultiplier to 1 just to test easily
      calculator.suggestedGasPriceMultiplier = FixedNumber.from(1);

      expect(
        (await calculator.suggestedDestinationGasPrice(destinationDomain)).toNumber()
      ).to.equal(gasPrice);
    });
  });
});
