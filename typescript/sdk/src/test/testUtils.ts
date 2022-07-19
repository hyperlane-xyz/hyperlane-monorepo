import { ethers } from 'ethers';

import { chainMetadata } from '../consts/chainMetadata';
import { AllChains } from '../consts/chains';
import {
  CoinGeckoResponse,
  CoinGeckoSimplePriceParams,
} from '../gas/token-prices';
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

// A mock CoinGecko intended to be used by tests
export class MockCoinGecko {
  private tokenPrices: Partial<ChainMap<ChainName, number>>;
  private idToChain: Record<string, ChainName>;

  constructor() {
    this.tokenPrices = {};
    this.idToChain = {};
    for (const chain of AllChains) {
      const id = chainMetadata[chain].coinGeckoId || chain;
      this.idToChain[id] = chain;
    }
  }

  price(params: CoinGeckoSimplePriceParams): Promise<CoinGeckoResponse> {
    const data: any = {};
    for (const id of params.ids) {
      data[id] = {
        usd: this.tokenPrices[this.idToChain[id]],
      };
    }
    return Promise.resolve({
      success: true,
      message: '',
      code: 200,
      data,
    });
  }

  get simple() {
    return this.price;
  }

  setTokenPrice(chain: ChainName, price: number) {
    this.tokenPrices[chain] = price;
  }
}
