import { ethers, FixedNumber } from 'ethers';
import { NameOrDomain } from '../src';

export const testAddresses = {
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
  },
};

const MOCK_NETWORK = {
  name: 'MockNetwork',
  chainId: 1337,
};

// A mock ethers Provider used for testing with mocked provider functionality
export class MockProvider extends ethers.providers.BaseProvider {

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

    return super.perform(method, params);
  }

  setMethodResolveValue(method: string, value: any) {
    this.methodResolveValues[method] = value;
  }

  clearMethodResolveValues() {
    this.methodResolveValues = {};
  }
}

// A mock TokenPriceGetter intended to be used by tests when mocking token prices
export class MockTokenPriceGetter {
  private tokenPrices: { [domain: number]: FixedNumber }

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

  setTokenPrice(domain: number, price: string | number) {
    this.tokenPrices[domain] = FixedNumber.from(price);
  }
}