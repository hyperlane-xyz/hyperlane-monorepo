import { ethers } from 'ethers';

import { ChainMap, ChainName } from '../types';

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
  private tokenPrices: Partial<ChainMap<Chain, number>>;

  constructor() {
    this.tokenPrices = {};
  }

  getTokenPrice(chain: Chain): Promise<number> {
    const price = this.tokenPrices[chain];
    if (price) {
      // TS compiler somehow can't deduce the check above
      return Promise.resolve(price as number);
    }
    throw Error(`No price for chain ${chain}`);
  }

  async getTokenExchangeRate(chainA: Chain, chainB: Chain): Promise<number> {
    const priceA = await this.getTokenPrice(chainA);
    const priceB = await this.getTokenPrice(chainA);
    return priceB / priceA;
  }

  setTokenPrice(chain: Chain, price: number) {
    this.tokenPrices[chain] = price;
  }
}
