import { formatMessage } from '@abacus-network/utils/dist/src/utils';
import { expect } from 'chai';
import { BigNumber, ethers, FixedNumber } from 'ethers';

import { AbacusCore } from '../../../src/core';
import { InterchainGasPayingMessage } from '../../../src/core/message/interchain-gas';
import { InterchainGasCalculator } from '../../../src/gas/interchain-gas-calculator';
import { MockProvider, MockTokenPriceGetter, testAddresses } from '../../utils';

describe('InterchainGasPayingMessage', () => {
  const originDomain = 1;
  const destinationDomain = 2;

  const testSerializedMessage = formatMessage(
    originDomain,
    ethers.constants.AddressZero,
    0,
    destinationDomain,
    ethers.constants.AddressZero,
    '0x12345678',
  );

  let core: AbacusCore;
  let interchainGasCalculator: InterchainGasCalculator;
  let tokenPriceGetter: MockTokenPriceGetter;
  let testMessage: InterchainGasPayingMessage;

  before(() => {
    core = new AbacusCore(testAddresses);
    const provider = new MockProvider();
    core.registerProvider('test1', provider);
    core.registerProvider('test2', provider);

    tokenPriceGetter = new MockTokenPriceGetter();
    // Origin domain token
    tokenPriceGetter.setTokenPrice(originDomain, 10);
    // Destination domain token
    tokenPriceGetter.setTokenPrice(destinationDomain, 5);
  });

  beforeEach(() => {
    interchainGasCalculator = new InterchainGasCalculator(core, {
      tokenPriceGetter,
    });
    testMessage = new InterchainGasPayingMessage(core, testSerializedMessage, {
      interchainGasCalculator,
    });
  });

  describe('estimateGasPayment', () => {
    it('estimates origin token payment using estimated destination gas', async () => {
      // Set the estimated destination gas
      const estimatedDestinationGas = 100_000;
      testMessage.estimateDestinationGas = () => Promise.resolve(ethers.BigNumber.from(estimatedDestinationGas));
      // Set destination gas price to 10 wei
      interchainGasCalculator.suggestedDestinationGasPrice = (_) => Promise.resolve(BigNumber.from(10));
      // Set paymentEstimateMultiplier to 1 just to test easily
      interchainGasCalculator.paymentEstimateMultiplier = FixedNumber.from(1);

      const estimatedPayment = await testMessage.estimateGasPayment();

      // 100_000 dest gas * 10 gas price * ($5 per origin token / $10 per origin token)
      expect(estimatedPayment.toNumber()).to.equal(500_000);
    });
  });
});
