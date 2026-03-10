import { expect } from 'chai';

import { HyperlaneJsonRpcProvider } from './HyperlaneJsonRpcProvider.js';

class TestHyperlaneJsonRpcProvider extends HyperlaneJsonRpcProvider {
  public readonly sentRequests: Array<{ method: string; params: any[] }> = [];
  public readonly getBlockCalls: any[] = [];
  public readonly getLogsCalls: any[] = [];

  constructor() {
    super(
      {
        http: 'http://127.0.0.1:8545',
        pagination: { maxBlockRange: 10 },
      } as any,
      {
        chainId: 31337,
        name: 'test',
      },
    );
  }

  override send(method: string, params: any[]): Promise<any> {
    this.sentRequests.push({ method, params });
    if (method === 'eth_getLogs') {
      throw new Error('eth_getLogs should not be called directly');
    }
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

  override getBlock(block: any): Promise<any> {
    this.getBlockCalls.push(block);
    return Promise.resolve({ number: 123 });
  }

  override getBlockNumber(): Promise<number> {
    return Promise.resolve(20);
  }

  override getLogs(filter: any): Promise<any> {
    this.getLogsCalls.push(filter);
    return Promise.resolve([
      {
        ...filter,
        toJSON: () => filter,
      },
    ]);
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

  it('forwards getBlock requests by block hash', async () => {
    const provider = new TestHyperlaneJsonRpcProvider();
    const blockHash =
      '0x1234567890123456789012345678901234567890123456789012345678901234';

    await provider.perform('getBlock', { blockHash });

    expect(provider.getBlockCalls).to.deep.equal([blockHash]);
  });

  it('paginates getLogs through getLogs to preserve log wrappers', async () => {
    const provider = new TestHyperlaneJsonRpcProvider();
    const logs = await provider.perform('getLogs', {
      filter: {
        address: '0x0000000000000000000000000000000000000001',
        topics: [
          '0x1234567890123456789012345678901234567890123456789012345678901234',
        ],
        fromBlock: 1,
        toBlock: 20,
      },
    });

    expect(provider.getLogsCalls).to.have.length(2);
    expect(
      provider.sentRequests.map((request) => request.method),
    ).to.not.include('eth_getLogs');
    expect(logs[0].toJSON()).to.deep.equal(provider.getLogsCalls[0]);
  });
});
