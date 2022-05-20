import { FixedNumber, ethers } from 'ethers';

import { ChainMap, ChainName } from '../src';

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
export class MockTokenPriceGetter<Chain extends ChainName> {
  private tokenPrices: Partial<ChainMap<Chain, FixedNumber>>;

  constructor() {
    this.tokenPrices = {};
  }

  getNativeTokenUsdPrice(chain: Chain): Promise<FixedNumber> {
    const price = this.tokenPrices[chain];
    if (price) {
      // TS compiler somehow can't deduce the check above
      return Promise.resolve(price as FixedNumber);
    }
    throw Error(`No price for chain ${chain}`);
  }

  setTokenPrice(chain: Chain, price: string | number) {
    this.tokenPrices[chain] = FixedNumber.from(price);
  }
}
