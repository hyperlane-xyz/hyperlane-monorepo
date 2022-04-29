import { ethers, FixedNumber } from 'ethers';
import { CoreContractAddresses, NameOrDomain } from '../src';
import { resolveId } from '../src/core/message';

const ZERO_ADDRESS = ethers.constants.AddressZero;

export type testNetworks = 'test1' | 'test2';
export const testAddresses: {
  [local in testNetworks]: CoreContractAddresses<testNetworks, local>;
} = {
  test1: {
    upgradeBeaconController: ZERO_ADDRESS,
    abacusConnectionManager: ZERO_ADDRESS,
    interchainGasPaymaster: ZERO_ADDRESS,
    outbox: {
      validatorManager: ZERO_ADDRESS,
      proxy: ZERO_ADDRESS,
      implementation: ZERO_ADDRESS,
      beacon: ZERO_ADDRESS,
    },
    inboxes: {
      test2: {
        validatorManager: ZERO_ADDRESS,
        proxy: ZERO_ADDRESS,
        implementation: ZERO_ADDRESS,
        beacon: ZERO_ADDRESS,
      },
    },
  },
  test2: {
    upgradeBeaconController: ZERO_ADDRESS,
    abacusConnectionManager: ZERO_ADDRESS,
    interchainGasPaymaster: ZERO_ADDRESS,
    outbox: {
      validatorManager: ZERO_ADDRESS,
      proxy: ZERO_ADDRESS,
      implementation: ZERO_ADDRESS,
      beacon: ZERO_ADDRESS,
    },
    inboxes: {
      test1: {
        validatorManager: ZERO_ADDRESS,
        proxy: ZERO_ADDRESS,
        implementation: ZERO_ADDRESS,
        beacon: ZERO_ADDRESS,
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
    const value = this.methodResolveValues[method];
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
  private tokenPrices: { [domain: number]: FixedNumber };

  constructor() {
    this.tokenPrices = {};
  }

  getNativeTokenUsdPrice(domain: NameOrDomain): Promise<FixedNumber> {
    const id = resolveId(domain);
    const price = this.tokenPrices[id];
    if (price) {
      return Promise.resolve(price);
    }
    throw Error(`No price for domain ${domain}`);
  }

  setTokenPrice(domain: number, price: string | number) {
    this.tokenPrices[domain] = FixedNumber.from(price);
  }
}
