import { expect } from 'chai';

import { HyperlaneJsonRpcProvider } from './HyperlaneJsonRpcProvider.js';

class TestHyperlaneJsonRpcProvider extends HyperlaneJsonRpcProvider {
  public readonly sentRequests: Array<{ method: string; params: any[] }> = [];

  constructor() {
    super({ http: 'http://127.0.0.1:8545' } as any, {
      chainId: 31337,
      name: 'test',
    });
  }

  override send(method: string, params: any[]): Promise<any> {
    this.sentRequests.push({ method, params });
    if (method === 'eth_sendRawTransaction') {
      return Promise.resolve(
        '0x1234567890123456789012345678901234567890123456789012345678901234',
      );
    }
    if (method === 'eth_gasPrice') {
      return Promise.resolve('0x2a');
    }
    return Promise.resolve('0x1');
  }

  override broadcastTransaction(_signedTx: string): Promise<any> {
    throw new Error(
      'broadcastTransaction should not be called for sendTransaction perform method',
    );
  }
}

describe('HyperlaneJsonRpcProvider', () => {
  it('routes sendTransaction to eth_sendRawTransaction and returns tx hash', async () => {
    const provider = new TestHyperlaneJsonRpcProvider();
    const signedTx =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const hash = await provider.perform('sendTransaction', {
      signedTransaction: signedTx,
    });

    expect(hash).to.equal(
      '0x1234567890123456789012345678901234567890123456789012345678901234',
    );
    expect(provider.sentRequests[0]).to.deep.equal({
      method: 'eth_sendRawTransaction',
      params: [signedTx],
    });
  });

  it('supports getGasPrice method', async () => {
    const provider = new TestHyperlaneJsonRpcProvider();
    const gasPrice = await provider.perform('getGasPrice', {});
    expect(gasPrice).to.equal(42n);
    expect(provider.sentRequests[0]).to.deep.equal({
      method: 'eth_gasPrice',
      params: [],
    });
  });
});
