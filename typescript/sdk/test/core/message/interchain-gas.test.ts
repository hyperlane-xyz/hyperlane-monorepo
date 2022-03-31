import { formatMessage } from '@abacus-network/utils/dist/src/utils';
import { expect } from 'chai';
import { BigNumber, ethers, FixedNumber } from 'ethers';

import { NameOrDomain } from '../../../src/types';
import { AbacusCore, InterchainGasPayingMessage } from '../../../src/core';

export const addresses = {
  test1: {
    upgradeBeaconController: '0x0000000000000000000000000000000000000000',
    xAppConnectionManager: '0x0000000000000000000000000000000000000000',
    validatorManager: '0x0000000000000000000000000000000000000000',
    interchainGasPaymaster: '0x0000000000000000000000000000000000000000',
    outbox: {
      proxy: '0x0000000000000000000000000000000000000000',
      implementation: '0x0000000000000000000000000000000000000000',
      beacon: '0x0000000000000000000000000000000000000000',
    },
    inboxes: {
      test2: {
        proxy: '0x0000000000000000000000000000000000000000',
        implementation: '0x0000000000000000000000000000000000000000',
        beacon: '0x0000000000000000000000000000000000000000',
      },
    },
  },
  test2: {
    upgradeBeaconController: '0x0000000000000000000000000000000000000000',
    xAppConnectionManager: '0x0000000000000000000000000000000000000000',
    validatorManager: '0x0000000000000000000000000000000000000000',
    interchainGasPaymaster: '0x0000000000000000000000000000000000000000',
    outbox: {
      proxy: '0x0000000000000000000000000000000000000000',
      implementation: '0x0000000000000000000000000000000000000000',
      beacon: '0x0000000000000000000000000000000000000000',
    },
    inboxes: {
      test1: {
        proxy: '0x0000000000000000000000000000000000000000',
        implementation: '0x0000000000000000000000000000000000000000',
        beacon: '0x0000000000000000000000000000000000000000',
      },
    },
  }
}

const MOCK_NETWORK = {
  name: 'MockNetwork',
  chainId: 1337,
};

class MockProvider extends ethers.providers.BaseProvider {

  private methodResolveValues: { [key: string]: any };

  constructor() {
    super(MOCK_NETWORK);

    this.methodResolveValues = {};
  }

  // Required to be implemented or the BaseProvider throws
  async detectNetwork() {
    return Promise.resolve(MOCK_NETWORK);
  }
  
  perform(method: string, params: any): Promise<any> {
    const value = this.methodResolveValues[method]
    if (value) {
      return Promise.resolve(value);
    }

    // switch (method) {
    //   case 'getGasPrice':
    //     return Promise.resolve(
    //       BigNumber.from(12345)
    //     );
    //   case 'estimateGas':
    //     return Promise.resolve(
    //       BigNumber.from(21000)
    //     );
    // }
    
    return super.perform(method, params);
  }

  setMethodResolveValue(method: string, value: any) {
    this.methodResolveValues[method] = value;
  }

  clearMethodResolveValues() {
    this.methodResolveValues = {};
  }
}

class TestTokenPriceGetter {
  tokenPrices: { [domain: number]: FixedNumber }

  constructor() {
    this.tokenPrices = {};
  }

  getNativeTokenUsdPrice(domain: NameOrDomain): Promise<FixedNumber> {
    const price = this.tokenPrices[domain as number];
    if (price) {
      return Promise.resolve(price);
    }
    throw Error(`No price for domain ${domain}`);
  }
}

describe('InterchainGasPayingMessage', () => {

  const testSerializedMessage = formatMessage(
    1,
    ethers.constants.AddressZero,
    0,
    2,
    ethers.constants.AddressZero,
    '0x12345678',
  );

  let core: AbacusCore;
  let provider: MockProvider;
  let tokenPriceGetter: TestTokenPriceGetter;
  let testMessage: InterchainGasPayingMessage;

  before(() => {
    core = new AbacusCore(addresses);
    provider = new MockProvider();
    core.registerProvider('test1', provider);
    core.registerProvider('test2', provider);

    tokenPriceGetter = new TestTokenPriceGetter();
    // Source domain token
    tokenPriceGetter.tokenPrices[1] = FixedNumber.from(10);
    // Destination domain token
    tokenPriceGetter.tokenPrices[2] = FixedNumber.from(5);
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
