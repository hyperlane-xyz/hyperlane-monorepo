import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import sinon from 'sinon';

import { utils } from '@abacus-network/utils';

import {
  AbacusCore,
  InterchainGasCalculator,
  NameOrDomain,
  ParsedMessage,
} from '../..';
import { MockProvider, MockTokenPriceGetter, testAddresses } from '../utils';

describe('InterchainGasCalculator', () => {
  const originDomain = 1;
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
    // Origin domain token
    tokenPriceGetter.setTokenPrice(originDomain, 10);
    // Destination domain token
    tokenPriceGetter.setTokenPrice(destinationDomain, 5);
  });

  beforeEach(() => {
    calculator = new InterchainGasCalculator(core, {
      tokenPriceGetter,
      // A multiplier of 1 makes testing easier to reason about
      paymentEstimateMultiplier: '1',
    });
  });

  afterEach(() => {
    sinon.restore();
    provider.clearMethodResolveValues();
  });

  describe('estimatePaymentForHandleGasAmount', () => {
    it('estimates origin token payment from a specified destination gas amount', async () => {
      const handleGas = BigNumber.from(100_000);

      // Set destination gas price to 10 wei
      const gasPrice = 10;
      provider.setMethodResolveValue('getGasPrice', BigNumber.from(gasPrice));

      // Stub the checkpoint relay gas cost
      const checkpointRelayGas = 100_000;
      sinon
        .stub(calculator, 'checkpointRelayGas')
        .returns(Promise.resolve(BigNumber.from(checkpointRelayGas)));
      // Stub the inbox process overhead gas
      const inboxProcessOverheadGas = 100_000;
      sinon
        .stub(calculator, 'inboxProcessOverheadGas')
        .returns(BigNumber.from(inboxProcessOverheadGas));

      const estimatedPayment =
        await calculator.estimatePaymentForHandleGasAmount(
          originDomain,
          destinationDomain,
          handleGas,
        );

      // (100_000 dest handler gas + 100_000 checkpoint relay gas + 100_000 process overhead gas)
      // * 10 gas price * ($5 per origin token / $10 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(1_500_000);
    });
  });

  describe('estimatePaymentForMessage', () => {
    it('estimates origin token payment from a specified message', async () => {
      // Set the estimated handle gas
      const estimatedHandleGas = 100_000;
      sinon
        .stub(calculator, 'estimateHandleGasForMessage')
        .returns(Promise.resolve(BigNumber.from(estimatedHandleGas)));
      // Set destination gas price to 10 wei
      const suggestedGasPrice = 10;
      sinon
        .stub(calculator, 'suggestedGasPrice')
        .returns(Promise.resolve(BigNumber.from(suggestedGasPrice)));
      // Stub the checkpoint relay gas cost
      const checkpointRelayGas = 100_000;
      sinon
        .stub(calculator, 'checkpointRelayGas')
        .returns(Promise.resolve(BigNumber.from(checkpointRelayGas)));
      // Stub the inbox process overhead gas
      const inboxProcessOverheadGas = 100_000;
      sinon
        .stub(calculator, 'inboxProcessOverheadGas')
        .returns(BigNumber.from(inboxProcessOverheadGas));

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

      // (100_000 dest handler gas + 100_000 checkpoint relay gas + 100_000 process overhead gas)
      // * 10 gas price * ($5 per origin token / $10 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(1_500_000);
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
      sinon
        .stub(calculator, 'nativeTokenDecimals')
        .callsFake((domain: number) => {
          if (domain === originDomain) {
            return 16;
          }
          return 18;
        });

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

  describe('checkpointRelayGas', () => {
    let threshold: number;

    // Mock the return value of InboxValidatorManager.threshold
    // to return `threshold`. Because the mocking involves a closure,
    // changing `threshold` will change the return value of InboxValidatorManager.threshold.
    before(() => {
      const getValidatorManangerStub = sinon.stub(
        core,
        'mustGetInboxValidatorManager',
      );
      getValidatorManangerStub.callsFake(
        (src: NameOrDomain, dest: NameOrDomain) => {
          // Get the "real" return value of mustGetInboxValidatorManager.
          // Ethers contracts are frozen using Object.freeze, so we make a copy
          // of the object so we can stub `threshold`.
          const validatorManager = Object.assign(
            {},
            getValidatorManangerStub.wrappedMethod.bind(core)(src, dest),
          );
          sinon
            .stub(validatorManager, 'threshold')
            .returns(Promise.resolve(BigNumber.from(threshold)));
          return validatorManager;
        },
      );
    });

    it('scales the gas cost with the quorum threshold', async () => {
      threshold = 2;
      const gasWithThresholdLow = await calculator.checkpointRelayGas(
        originDomain,
        destinationDomain,
      );

      threshold = 3;
      const gasWithThresholdHigh = await calculator.checkpointRelayGas(
        originDomain,
        destinationDomain,
      );

      expect(gasWithThresholdHigh.gt(gasWithThresholdLow)).to.be.true;
    });
  });
});
