import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { Chains } from '../consts/chains';
import { HyperlaneCore } from '../core/HyperlaneCore';
import { CoreContracts } from '../core/contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { MockProvider, MockTokenPriceGetter } from '../test/testUtils';
import { ChainName, TestChainNames } from '../types';

import { InterchainGasCalculator, ParsedMessage } from './calculator';

const HANDLE_GAS = 100_000;
const SUGGESTED_GAS_PRICE = 10;
const INBOX_PROCESS_OVERHEAD_GAS = 100_000;

// Exposes protected methods so they can be stubbed.
class TestInterchainGasCalculator<
  Chain extends ChainName,
> extends InterchainGasCalculator<Chain> {
  estimateGasForProcess<Destination extends Chain>(
    origin: Exclude<Chain, Destination>,
    destination: Destination,
  ): Promise<BigNumber> {
    return super.estimateGasForProcess(origin, destination);
  }
  estimateGasForHandle<LocalChain extends Chain>(
    message: ParsedMessage<Chain, LocalChain>,
  ): Promise<BigNumber> {
    return super.estimateGasForHandle(message);
  }
  convertBetweenTokens(
    fromChain: Chain,
    toChain: Chain,
    fromAmount: BigNumber,
  ): Promise<BigNumber> {
    return super.convertBetweenTokens(fromChain, toChain, fromAmount);
  }
  tokenDecimals(chain: Chain): number {
    return super.tokenDecimals(chain);
  }
  getGasPrice(chain: Chain): Promise<BigNumber> {
    return super.getGasPrice(chain);
  }
}

describe('InterchainGasCalculator', () => {
  const provider = new MockProvider();
  // TODO: fix types to not require the <any> here.
  // This is because InterchainGasCalculator isn't very strongly typed,
  // which is because ParsedMessage isn't very strongly typed. This results
  // in InterchainGasCalculator expecting a multiprovider with providers for
  // every chain.
  const multiProvider = new MultiProvider({
    test1: { provider },
    test2: { provider },
    test3: { provider },
  });
  const core: HyperlaneCore<TestChainNames> = HyperlaneCore.fromEnvironment(
    'test',
    multiProvider,
  );
  const origin = Chains.test1;
  const destination = Chains.test2;

  let tokenPriceGetter: MockTokenPriceGetter;
  let calculator: TestInterchainGasCalculator<TestChainNames>;

  beforeEach(() => {
    tokenPriceGetter = new MockTokenPriceGetter();
    tokenPriceGetter.setTokenPrice(origin, 9.0909);
    tokenPriceGetter.setTokenPrice(destination, 5.5);
    calculator = new TestInterchainGasCalculator(multiProvider, core, {
      tokenPriceGetter,
      // A multiplier of 1 makes testing easier to reason about
      paymentEstimateMultiplier: '1',
    });
  });

  afterEach(() => {
    sinon.restore();
    provider.clearMethodResolveValues();
  });

  describe('estimatePaymentForGas', () => {
    it('estimates origin token payment from a specified destination gas amount', async () => {
      // Set destination gas price to 10 wei
      provider.setMethodResolveValue(
        'getGasPrice',
        BigNumber.from(SUGGESTED_GAS_PRICE),
      );

      const estimatedPayment = await calculator.estimatePaymentForGas(
        origin,
        destination,
        BigNumber.from(HANDLE_GAS),
      );

      // 100k gas * 10 gas price * ($5.5 per destination token / $9.0909 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(605_000);
    });
  });

  describe('estimatePaymentForHandleGas', () => {
    it('estimates origin token payment from a specified destination handle gas amount', async () => {
      // Set destination gas price to 10 wei
      provider.setMethodResolveValue(
        'getGasPrice',
        BigNumber.from(SUGGESTED_GAS_PRICE),
      );

      // Stub the inbox process overhead gas
      sinon
        .stub(calculator, 'estimateGasForProcess')
        .returns(Promise.resolve(BigNumber.from(INBOX_PROCESS_OVERHEAD_GAS)));

      const estimatedPayment = await calculator.estimatePaymentForHandleGas(
        origin,
        destination,
        BigNumber.from(HANDLE_GAS),
      );

      // (100_000 dest handler gas + 100_000 process overhead gas)
      // * 10 gas price * ($5.5 per destination token / $9.0909 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(1_210_000);
    });
  });

  /*
  describe('estimatePaymentForMessage', () => {
    it('estimates origin token payment from a specified message', async () => {
      // Set destination gas price to 10 wei
      provider.setMethodResolveValue(
        'getGasPrice',
        BigNumber.from(SUGGESTED_GAS_PRICE),
      );
      // Set the estimated handle gas
      sinon
        .stub(calculator, 'estimateGasForHandle')
        .returns(Promise.resolve(BigNumber.from(HANDLE_GAS)));
      // Stub the inbox process overhead gas
      sinon
        .stub(calculator, 'estimateGasForProcess')
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

      // (100_000 dest handler gas + 100_000 process overhead gas)
      // * 10 gas price * ($5.5 per destination token / $9.0909 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(1_210_000);
    });
  });
  */

  describe('convertBetweenTokens', () => {
    const destinationWei = BigNumber.from('1000');

    it('converts using the USD value of origin and destination native tokens', async () => {
      const originWei = await calculator.convertBetweenTokens(
        destination,
        origin,
        destinationWei,
      );

      // 1000 * (5.5 / 9.0909)
      expect(originWei.toNumber()).to.equal(605);
    });

    it('considers when the origin token decimals > the destination token decimals', async () => {
      calculator.tokenDecimals = (chain: TestChainNames) => {
        if (chain === origin) {
          return 20;
        }
        return 18;
      };

      const originWei = await calculator.convertBetweenTokens(
        destination,
        origin,
        destinationWei,
      );

      // 1000 * (5.5 / 9.0909) * 100
      expect(originWei.toNumber()).to.equal(60500);
    });

    it('considers when the origin token decimals < the destination token decimals', async () => {
      sinon
        .stub(calculator, 'tokenDecimals')
        .callsFake((chain: TestChainNames) => {
          if (chain === origin) {
            return 16;
          }
          return 18;
        });

      const originWei = await calculator.convertBetweenTokens(
        destination,
        origin,
        destinationWei,
      );

      // 1000 * (5.5 / 9.0909) / 100
      expect(originWei.toNumber()).to.equal(6);
    });
  });

  describe('getGasPrice', () => {
    it('gets the gas price from the provider', async () => {
      provider.setMethodResolveValue(
        'getGasPrice',
        BigNumber.from(SUGGESTED_GAS_PRICE),
      );

      expect((await calculator.getGasPrice(destination)).toNumber()).to.equal(
        SUGGESTED_GAS_PRICE,
      );
    });
  });

  describe('estimateGasForProcess', () => {
    let threshold: number;
    // Mock the return value of MultisigIsm.threshold
    // to return `threshold`. Because the mocking involves a closure,
    // changing `threshold` will change the return value of MultisigIsm.threshold.
    before(() => {
      const getContractsStub = sinon.stub(core, 'getContracts');
      let thresholdStub: sinon.SinonStub | undefined;
      getContractsStub.callsFake((chain) => {
        // Get the "real" return value of getContracts.
        const contracts: CoreContracts =
          getContractsStub.wrappedMethod.bind(core)(chain);

        // Ethers contracts are frozen using Object.freeze, so we make a copy
        // of the object so we can stub `threshold`.
        const multisigIsm = Object.assign({}, contracts.multisigIsm);

        // Because we are stubbing vaidatorManager.threshold when core.getContracts gets called,
        // we must ensure we don't try to stub more than once or sinon will complain.
        if (!thresholdStub) {
          thresholdStub = sinon
            .stub(multisigIsm, 'threshold')
            .callsFake(() => Promise.resolve(threshold));

          contracts.multisigIsm = multisigIsm;
        }
        return contracts;
      });
    });

    it('scales the gas cost with the quorum threshold', async () => {
      threshold = 2;
      const gasWithThresholdLow = await calculator.estimateGasForProcess(
        origin,
        destination,
      );

      threshold = 3;
      const gasWithThresholdHigh = await calculator.estimateGasForProcess(
        origin,
        destination,
      );

      expect(gasWithThresholdHigh.gt(gasWithThresholdLow)).to.be.true;
    });
  });
});
