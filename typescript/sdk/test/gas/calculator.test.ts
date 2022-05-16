import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import sinon from 'sinon';

import { utils } from '@abacus-network/utils';

import {
  AbacusCore,
  Chains,
  InterchainGasCalculator,
  MultiProvider,
} from '../..';
import { ParsedMessage } from '../../src/gas/calculator';
import { TestChainNames } from '../../src/types';
import { MockProvider, MockTokenPriceGetter } from '../utils';

const HANDLE_GAS = 100_000;
const SUGGESTED_GAS_PRICE = 10;
const CHECKPOINT_RELAY_GAS = 100_000;
const INBOX_PROCESS_OVERHEAD_GAS = 100_000;

describe('InterchainGasCalculator', () => {
  const provider = new MockProvider();
  // TODO: fix types to not require the <any> here.
  // This is because InterchainGasCalculator isn't very strongly typed,
  // which is because ParsedMessage isn't very strongly typed. This results
  // in InterchainGasCalculator expecting a multiprovider with providers for
  // every network.
  const multiProvider = new MultiProvider({
    test1: { provider },
    test2: { provider },
    test3: { provider },
  });
  const core = AbacusCore.fromEnvironment(
    'test',
    multiProvider,
  ) as AbacusCore<TestChainNames>;
  const origin = Chains.test1;
  const destination = Chains.test2;

  let tokenPriceGetter: MockTokenPriceGetter<TestChainNames>;
  let calculator: InterchainGasCalculator<TestChainNames>;

  beforeEach(() => {
    tokenPriceGetter = new MockTokenPriceGetter();
    // Origin token
    tokenPriceGetter.setTokenPrice(origin, 10);
    // Destination token
    tokenPriceGetter.setTokenPrice(destination, 5);
    calculator = new InterchainGasCalculator(multiProvider, core, {
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
      // Set destination gas price to 10 wei
      provider.setMethodResolveValue(
        'getGasPrice',
        BigNumber.from(SUGGESTED_GAS_PRICE),
      );

      // Stub the checkpoint relay gas cost
      sinon
        .stub(calculator, 'checkpointRelayGas')
        .returns(Promise.resolve(BigNumber.from(CHECKPOINT_RELAY_GAS)));
      // Stub the inbox process overhead gas
      sinon
        .stub(calculator, 'inboxProcessOverheadGas')
        .returns(Promise.resolve(BigNumber.from(INBOX_PROCESS_OVERHEAD_GAS)));

      const estimatedPayment =
        await calculator.estimatePaymentForHandleGasAmount(
          origin,
          destination,
          BigNumber.from(HANDLE_GAS),
        );

      // (100_000 dest handler gas + 100_000 checkpoint relay gas + 100_000 process overhead gas)
      // * 10 gas price * ($5 per origin token / $10 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(1_500_000);
    });
  });

  describe('estimatePaymentForMessage', () => {
    it('estimates origin token payment from a specified message', async () => {
      // Set the estimated handle gas
      sinon
        .stub(calculator, 'estimateHandleGasForMessage')
        .returns(Promise.resolve(BigNumber.from(HANDLE_GAS)));
      // Set destination gas price to 10 wei
      sinon
        .stub(calculator, 'suggestedGasPrice')
        .returns(Promise.resolve(BigNumber.from(SUGGESTED_GAS_PRICE)));
      // Stub the checkpoint relay gas cost
      sinon
        .stub(calculator, 'checkpointRelayGas')
        .returns(Promise.resolve(BigNumber.from(CHECKPOINT_RELAY_GAS)));
      // Stub the inbox process overhead gas
      sinon
        .stub(calculator, 'inboxProcessOverheadGas')
        .returns(Promise.resolve(BigNumber.from(INBOX_PROCESS_OVERHEAD_GAS)));

      const zeroAddressBytes32 = utils.addressToBytes32(
        ethers.constants.AddressZero,
      );
      const message: ParsedMessage<TestChainNames, Chains.test2> = {
        origin: origin,
        sender: zeroAddressBytes32,
        destination: destination,
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
    const destinationWei = BigNumber.from('1000');

    it('converts using the USD value of origin and destination native tokens', async () => {
      const originWei = await calculator.convertBetweenNativeTokens(
        destination,
        origin,
        destinationWei,
      );

      expect(originWei.toNumber()).to.equal(500);
    });

    it('considers when the origin token decimals > the destination token decimals', async () => {
      calculator.nativeTokenDecimals = (chain: TestChainNames) => {
        if (chain === origin) {
          return 20;
        }
        return 18;
      };

      const originWei = await calculator.convertBetweenNativeTokens(
        destination,
        origin,
        destinationWei,
      );

      expect(originWei.toNumber()).to.equal(50000);
    });

    it('considers when the origin token decimals < the destination token decimals', async () => {
      sinon
        .stub(calculator, 'nativeTokenDecimals')
        .callsFake((chain: TestChainNames) => {
          if (chain === origin) {
            return 16;
          }
          return 18;
        });

      const originWei = await calculator.convertBetweenNativeTokens(
        destination,
        origin,
        destinationWei,
      );

      expect(originWei.toNumber()).to.equal(5);
    });
  });

  describe('suggestedGasPrice', () => {
    it('gets the gas price from the provider', async () => {
      provider.setMethodResolveValue(
        'getGasPrice',
        BigNumber.from(SUGGESTED_GAS_PRICE),
      );

      expect(
        (await calculator.suggestedGasPrice(destination)).toNumber(),
      ).to.equal(SUGGESTED_GAS_PRICE);
    });
  });

  describe('checkpointRelayGas', () => {
    let threshold: number;
    // Mock the return value of InboxValidatorManager.threshold
    // to return `threshold`. Because the mocking involves a closure,
    // changing `threshold` will change the return value of InboxValidatorManager.threshold.
    before(() => {
      const getContractsStub = sinon.stub(core, 'getContracts');
      let thresholdStub: sinon.SinonStub | undefined;
      getContractsStub.callsFake((chain) => {
        // Get the "real" return value of getContracts.
        const contracts = getContractsStub.wrappedMethod.bind(core)(chain);

        // Ethers contracts are frozen using Object.freeze, so we make a copy
        // of the object so we can stub `threshold`.
        const validatorManager = Object.assign(
          {},
          // @ts-ignore Typescript has trouble properly typing the stubbed getContracts
          contracts.inboxes[origin].validatorManager,
        );

        // Because we are stubbing vaidatorManager.threshold when core.getContracts gets called,
        // we must ensure we don't try to stub more than once or sinon will complain.
        if (!thresholdStub) {
          thresholdStub = sinon
            .stub(validatorManager, 'threshold')
            .callsFake(() => Promise.resolve(BigNumber.from(threshold)));

          // @ts-ignore Typescript has trouble properly typing the stubbed getContracts
          contracts.inboxes[origin].validatorManager = validatorManager;
        }
        return contracts;
      });
    });

    it('scales the gas cost with the quorum threshold', async () => {
      threshold = 2;
      const gasWithThresholdLow = await calculator.checkpointRelayGas(
        origin,
        destination,
      );

      threshold = 3;
      const gasWithThresholdHigh = await calculator.checkpointRelayGas(
        origin,
        destination,
      );

      expect(gasWithThresholdHigh.gt(gasWithThresholdLow)).to.be.true;
    });
  });
});
