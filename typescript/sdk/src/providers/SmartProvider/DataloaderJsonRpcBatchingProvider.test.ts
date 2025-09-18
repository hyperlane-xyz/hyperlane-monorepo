import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';

import { randomAddress } from '../../test/testUtils.js';

import {
  AllowedEvmReadMethods,
  DataLoaderJsonRpcBatchingProvider,
} from './DataloaderJsonRpcBatchingProvider.js';

chai.use(chaiAsPromised);

describe('DataLoaderJsonRpcBatchingProvider', () => {
  let provider: DataLoaderJsonRpcBatchingProvider;
  let fetchStub: sinon.SinonStub;

  const MOCK_URL = 'https://eth-mainnet.example.com';
  const MOCK_CHAIN_ID = 1;

  beforeEach(() => {
    // Mock fetch globally
    fetchStub = sinon.stub(global, 'fetch');
    provider = new DataLoaderJsonRpcBatchingProvider(MOCK_URL, MOCK_CHAIN_ID);
  });

  afterEach(() => {
    fetchStub.restore();
  });

  // Helper function to mock batch responses
  function mockBatchResponse(results: any[]) {
    fetchStub.callsFake(async (_url, options) => {
      const requestBody: { id: number }[] = JSON.parse(options.body);
      const requestIds = requestBody.map((req: any) => req.id);
      return {
        ok: true,
        json: async () =>
          requestIds.map((id, index) => ({
            id,
            result: results[index],
            jsonrpc: '2.0',
          })),
      };
    });
  }

  // Helper function to mock parent class send method
  function mockParentClassSendMethod(result: any) {
    const parentSendStub = sinon
      .stub(provider.constructor.prototype.__proto__, 'send')
      .resolves(result);
    return parentSendStub;
  }

  describe('constructor', () => {
    it('should create provider with correct configuration', () => {
      expect(provider).to.be.instanceOf(DataLoaderJsonRpcBatchingProvider);
      expect(provider.connection.url).to.equal(MOCK_URL);
      expect(provider.network.chainId).to.equal(MOCK_CHAIN_ID);
    });
  });

  describe('method routing', () => {
    it('should route single batch requests through super.send', async () => {
      const parentSendStub = mockParentClassSendMethod('0x1234');

      const result = await provider.send(AllowedEvmReadMethods.GET_BALANCE, [
        '0x742d35Cc6634C0532925a3b8D0b4E0473A3e92C',
        'latest',
      ]);

      expect(result).to.equal('0x1234');
      expect(parentSendStub.calledOnce).to.be.true;
      // Single requests should not use fetch
      expect(fetchStub.called).to.be.false;

      parentSendStub.restore();
    });

    it('should route non-allowed methods through super.send', async () => {
      const parentSendStub = mockParentClassSendMethod('super-result');

      const result = await provider.send('eth_sendTransaction', [
        { to: '0x742d35Cc6634C0532925a3b8D0b4E0473A3e92C', value: '0x1' },
      ]);

      expect(result).to.equal('super-result');
      expect(parentSendStub.calledOnce).to.be.true;
      expect(fetchStub.called).to.be.false;

      parentSendStub.restore();
    });

    it('should not batch write operations', async () => {
      const parentSendStub = mockParentClassSendMethod('write-result');

      await provider.send('eth_sendTransaction', [{}]);
      await provider.send('eth_sendRawTransaction', ['0x']);

      expect(parentSendStub.calledTwice).to.be.true;
      expect(fetchStub.called).to.be.false;

      parentSendStub.restore();
    });
  });

  describe('batching functionality', () => {
    it('should batch multiple concurrent requests', async () => {
      mockBatchResponse(['0x1234', '0x5678']);

      // Make multiple concurrent requests through the provider
      const address1 = randomAddress();
      const address2 = randomAddress();
      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [address1, 'latest']),
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [address2, 'latest']),
      ];

      const results = await Promise.all(promises);

      expect(results).to.deep.equal(['0x1234', '0x5678']);
      expect(fetchStub.calledOnce).to.be.true;

      // Verify fetch was called with an array containing our requests
      const fetchCall = fetchStub.getCall(0);
      const requestBody = JSON.parse(fetchCall.args[1].body);
      expect(requestBody).to.be.instanceOf(Array);
      expect(requestBody).to.have.lengthOf(2);
      expect(requestBody[0]).to.deep.include({
        method: AllowedEvmReadMethods.GET_BALANCE,
        params: [address1, 'latest'],
        jsonrpc: '2.0',
      });
      expect(requestBody[1]).to.deep.include({
        method: AllowedEvmReadMethods.GET_BALANCE,
        params: [address2, 'latest'],
        jsonrpc: '2.0',
      });
      // Verify IDs are sequential
      expect(requestBody[1].id).to.equal(requestBody[0].id + 1);
    });
  });

  describe('error handling', () => {
    it('should handle JSON-RPC errors in batch response', async () => {
      fetchStub.callsFake(async (_url, options) => {
        const requestBody = JSON.parse(options.body);
        const requestIds = requestBody.map((req: any) => req.id);
        return {
          ok: true,
          json: async () => [
            {
              id: requestIds[0],
              error: { code: -32000, message: 'Invalid block number' },
              jsonrpc: '2.0',
            },
            { id: requestIds[1], result: '0x5678', jsonrpc: '2.0' },
          ],
        };
      });

      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'invalid',
        ]),
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
      ];

      const results = await Promise.allSettled(promises);

      expect(results[0].status).to.equal('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).to.include(
        'Invalid block number',
      );
      expect(results[1].status).to.equal('fulfilled');
      expect((results[1] as PromiseFulfilledResult<any>).value).to.equal(
        '0x5678',
      );
    });

    it('should handle network errors', async () => {
      fetchStub.rejects(new Error('Network error: Connection timeout'));

      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
      ];

      await expect(Promise.all(promises)).to.be.rejectedWith(
        'Network error: Connection timeout',
      );
    });

    it('should handle HTTP 500 server errors', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error details',
      });

      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
      ];

      await expect(Promise.all(promises)).to.be.rejectedWith(
        'Batch request failed with error code Internal Server Error',
      );
    });
  });

  describe('duplicate request handling', () => {
    it('should handle duplicate requests efficiently', async () => {
      const parentSendStub = mockParentClassSendMethod('0x1234');

      // Make the same request multiple times concurrently
      const requestMethod = AllowedEvmReadMethods.GET_BALANCE;
      const requestParams = [randomAddress(), 'latest'];

      const promises = [
        provider.send(requestMethod, requestParams),
        provider.send(requestMethod, requestParams),
        provider.send(requestMethod, requestParams),
      ];

      const results = await Promise.all(promises);

      expect(results).to.deep.equal(['0x1234', '0x1234', '0x1234']);

      // Should only call parent send once due to DataLoader deduplication + single request optimization
      expect(parentSendStub.calledOnce).to.be.true;
      expect(fetchStub.called).to.be.false;

      parentSendStub.restore();
    });
  });

  describe('different RPC methods', () => {
    it('should handle different allowed RPC methods in a batch', async () => {
      mockBatchResponse(['0x1234', '0x5678', '42']);

      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
        provider.send(AllowedEvmReadMethods.GET_CODE, [
          randomAddress(),
          'latest',
        ]),
        provider.send(AllowedEvmReadMethods.BLOCK_NUMBER, []),
      ];

      const results = await Promise.all(promises);

      expect(results).to.deep.equal(['0x1234', '0x5678', '42']);
      expect(fetchStub.calledOnce).to.be.true;

      const requestBody = JSON.parse(fetchStub.getCall(0).args[1].body);
      expect(requestBody).to.have.lengthOf(3);
      expect(requestBody[0].method).to.equal(AllowedEvmReadMethods.GET_BALANCE);
      expect(requestBody[1].method).to.equal(AllowedEvmReadMethods.GET_CODE);
      expect(requestBody[2].method).to.equal(
        AllowedEvmReadMethods.BLOCK_NUMBER,
      );
    });
  });

  describe('response ordering', () => {
    it('should return responses in request order even if server returns out of order', async () => {
      fetchStub.callsFake(async (_url, options) => {
        const requestBody = JSON.parse(options.body);
        const requestIds = requestBody.map((req: any) => req.id);

        // Return responses in reverse order to test ordering
        return {
          ok: true,
          json: async () => [
            { id: requestIds[2], result: 'third', jsonrpc: '2.0' },
            { id: requestIds[0], result: 'first', jsonrpc: '2.0' },
            { id: requestIds[1], result: 'second', jsonrpc: '2.0' },
          ],
        };
      });

      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, ['0x1', 'latest']),
        provider.send(AllowedEvmReadMethods.GET_CODE, ['0x2', 'latest']),
        provider.send(AllowedEvmReadMethods.BLOCK_NUMBER, []),
      ];

      const results = await Promise.all(promises);

      // Results should be in the same order as requests, not server response order
      expect(results).to.deep.equal(['first', 'second', 'third']);
    });
  });

  describe('malformed responses', () => {
    it('should handle invalid JSON responses', async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => {
          throw new Error('Unexpected token in JSON');
        },
      });

      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
        provider.send(AllowedEvmReadMethods.GET_CODE, [
          randomAddress(),
          'latest',
        ]),
      ];

      const results = await Promise.allSettled(promises);

      expect(results[0].status).to.equal('rejected');
      expect(results[1].status).to.equal('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).to.include(
        'Invalid JSON response',
      );
      expect((results[1] as PromiseRejectedResult).reason.message).to.include(
        'Invalid JSON response',
      );
    });

    it('should fail entire batch when response ID is missing', async () => {
      fetchStub.callsFake(async (url, options) => {
        const requestBody = JSON.parse(options.body);
        const requestIds = requestBody.map((req: any) => req.id);

        return {
          ok: true,
          json: async () => [
            { id: requestIds[0], result: '0x1234', jsonrpc: '2.0' },
          ],
        };
      });

      const promises = [
        provider.send(AllowedEvmReadMethods.GET_BALANCE, [
          randomAddress(),
          'latest',
        ]),
        provider.send(AllowedEvmReadMethods.GET_CODE, [
          randomAddress(),
          'latest',
        ]),
      ];

      const results = await Promise.allSettled(promises);

      // Both requests should fail because the batch fails when any response is missing
      expect(results[0].status).to.equal('rejected');
      expect(results[1].status).to.equal('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).to.include(
        'json rpc response was not found',
      );
      expect((results[1] as PromiseRejectedResult).reason.message).to.include(
        'json rpc response was not found',
      );
    });
  });
});
