import { ethers } from 'ethers';

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
