import { expect } from 'chai';

import { HyperlaneEtherscanProvider } from './HyperlaneEtherscanProvider.js';

class TestHyperlaneEtherscanProvider extends HyperlaneEtherscanProvider {
  public readonly getBlockCalls: any[] = [];

  constructor() {
    super(
      {
        apiUrl: 'https://etherscan.io/api',
        family: 'etherscan',
        name: 'etherscan',
      } as any,
      {
        chainId: 1,
        name: 'ethereum',
      },
    );
  }

  override getBlock(block: any): Promise<any> {
    this.getBlockCalls.push(block);
    return Promise.resolve({ number: 123 });
  }
}

describe('HyperlaneEtherscanProvider', () => {
  it('forwards getBlock requests by block hash', async () => {
    const provider = new TestHyperlaneEtherscanProvider();
    const blockHash =
      '0x1234567890123456789012345678901234567890123456789012345678901234';

    await provider.perform('getBlock', { blockHash });

    expect(provider.getBlockCalls).to.deep.equal([blockHash]);
  });
});
