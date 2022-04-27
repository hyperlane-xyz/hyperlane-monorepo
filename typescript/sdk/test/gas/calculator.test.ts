import { utils } from '@abacus-network/utils';
import { expect } from 'chai';
import { BigNumber, ethers, FixedNumber } from 'ethers';
import {
  AbacusCore,
  InterchainGasCalculator,
  MultiProvider,
  ParsedMessage,
} from '../..';
import { MockProvider, MockTokenPriceGetter, testAddresses } from '../utils';

describe('InterchainGasCalculator', () => {
  const originDomain = 1;
  const destinationDomain = 2;

  let core: AbacusCore;
  let provider: MockProvider;
  let multiProvider: MultiProvider;
  let tokenPriceGetter: MockTokenPriceGetter;
  let calculator: InterchainGasCalculator;

  before(() => {
    provider = new MockProvider();

    multiProvider = new MultiProvider({
      test1: provider,
      test2: provider,
    } as any);

    core = new AbacusCore(testAddresses as any, multiProvider);

    tokenPriceGetter = new MockTokenPriceGetter();
    // Origin domain token
    tokenPriceGetter.setTokenPrice(originDomain, 10);
    // Destination domain token
    tokenPriceGetter.setTokenPrice(destinationDomain, 5);
  });

  beforeEach(() => {
    calculator = new InterchainGasCalculator(multiProvider, core, {
      tokenPriceGetter,
    });
  });

  afterEach(() => {
    provider.clearMethodResolveValues();
  });

  describe('estimatePaymentForGasAmount', () => {
    it('estimates origin token payment from a specified destination gas amount', async () => {
      const destinationGas = BigNumber.from(100_000);

      // Set destination gas price to 10 wei
      provider.setMethodResolveValue('getGasPrice', BigNumber.from(10));

      // Set paymentEstimateMultiplier to 1 just to test easily
      calculator.paymentEstimateMultiplier = FixedNumber.from(1);

      const estimatedPayment = await calculator.estimatePaymentForGasAmount(
        originDomain,
        destinationDomain,
        destinationGas,
      );

      // 100_000 dest gas * 10 gas price * ($5 per origin token / $10 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(500_000);
    });
  });

  describe('estimatePaymentForMessage', () => {
    it('estimates origin token payment from a specified message', async () => {
      // Set the estimated destination gas
      const estimatedDestinationGas = 100_000;
      calculator.estimateGasForMessage = () =>
        Promise.resolve(BigNumber.from(estimatedDestinationGas));
      // Set destination gas price to 10 wei
      calculator.suggestedGasPrice = (_) => Promise.resolve(BigNumber.from(10));
      // Set paymentEstimateMultiplier to 1 just to test easily
      calculator.paymentEstimateMultiplier = FixedNumber.from(1);

      const zeroAddressBytes32 = utils.addressToBytes32(
        ethers.constants.AddressZero,
      );
      const message: ParsedMessage = {
        origin: originDomain,
        sender: zeroAddressBytes32,
        destination: destinationDomain,
        recipient: zeroAddressBytes32,
        body: '0x12345678',
      };

      const estimatedPayment = await calculator.estimatePaymentForMessage(
        message,
      );

      // 100_000 dest gas * 10 gas price * ($5 per origin token / $10 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(500_000);
    });
  });

  describe('convertBetweenNativeTokens', () => {
    it('converts using the USD value of origin and destination native tokens', async () => {
      const destinationWei = BigNumber.from('1000');
      const originWei = await calculator.convertBetweenNativeTokens(
        destinationDomain,
        originDomain,
        destinationWei,
      );

      expect(originWei.toNumber()).to.equal(500);
    });

    it('considers when the origin token decimals > the destination token decimals', async () => {
      calculator.nativeTokenDecimals = (domain: number) => {
        if (domain === originDomain) {
          return 20;
        }
        return 18;
      };

      const destinationWei = BigNumber.from('1000');
      const originWei = await calculator.convertBetweenNativeTokens(
        destinationDomain,
        originDomain,
        destinationWei,
      );

      expect(originWei.toNumber()).to.equal(50000);
    });

    it('considers when the origin token decimals < the destination token decimals', async () => {
      calculator.nativeTokenDecimals = (domain: number) => {
        if (domain === originDomain) {
          return 16;
        }
        return 18;
      };

      const destinationWei = BigNumber.from('1000');
      const originWei = await calculator.convertBetweenNativeTokens(
        destinationDomain,
        originDomain,
        destinationWei,
      );

      expect(originWei.toNumber()).to.equal(5);
    });
  });

  describe('suggestedGasPrice', () => {
    it('gets the gas price from the provider', async () => {
      const gasPrice = 1000;
      provider.setMethodResolveValue('getGasPrice', BigNumber.from(gasPrice));

      expect(
        (await calculator.suggestedGasPrice(destinationDomain)).toNumber(),
      ).to.equal(gasPrice);
    });
  });
});
