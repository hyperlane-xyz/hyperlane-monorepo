import { expect } from 'chai';
import { TestChainName, test1, test2 } from '../consts/testChains.js';
import type { ProtocolTransaction, ProtocolReceipt } from './ProviderType.js';
import { EthJsonRpcBlockParameterTag } from '../metadata/chainMetadataTypes.js';
import sinon from 'sinon';

import { MultiProvider } from './MultiProvider.js';

describe('MultiProvider', () => {
  describe('handleTx', () => {
    let multiProvider: MultiProvider;

    beforeEach(() => {
      const chainMetadata = {
        [TestChainName.test1]: test1,
        [TestChainName.test2]: test2,
      };
      multiProvider = new MultiProvider(chainMetadata);
    });

    it('should timeout when numeric confirmation never resolves', async () => {
      const mockTx = {
        hash: '0xabc123def456',
        wait: sinon.stub().returns(new Promise(() => {})),
      } as unknown as ProtocolTransaction<any>;

      try {
        await multiProvider.handleTx(TestChainName.test1, mockTx, {
          timeoutMs: 100,
        });
        throw new Error('Expected timeout error');
      } catch (error: any) {
        expect(error.message).to.include('Timeout');
        expect(error.message).to.include('0xabc123def456');
        expect(error.message).to.include('confirmations');
      }
    });

    it('should return receipt when numeric confirmation resolves before timeout', async () => {
      const mockReceipt = {
        transactionHash: '0xabc123def456',
        blockNumber: 100,
        status: 1,
      } as unknown as ProtocolReceipt<any>;

      const mockTx = {
        hash: '0xabc123def456',
        wait: sinon.stub().resolves(mockReceipt),
      } as unknown as ProtocolTransaction<any>;

      const result = await multiProvider.handleTx(TestChainName.test1, mockTx, {
        timeoutMs: 5000,
      });

      expect(result).to.deep.equal(mockReceipt);
      expect(mockTx.wait.calledOnce).to.be.true;
    });

    it('should wait for inclusion when wait(0) returns null', async () => {
      const mockReceipt = {
        transactionHash: '0xabc123def456',
        blockNumber: 100,
        status: 1,
      } as unknown as ProtocolReceipt<any>;

      const waitStub = sinon
        .stub()
        .callsFake(async (confirmations?: number) => {
          if (confirmations === 0) return null;
          return mockReceipt;
        });

      const mockTx = {
        hash: '0xabc123def456',
        wait: waitStub,
      } as unknown as ProtocolTransaction<any>;

      const result = await multiProvider.handleTx(TestChainName.test1, mockTx, {
        waitConfirmations: 0,
        timeoutMs: 5000,
      });

      expect(result).to.deep.equal(mockReceipt);
      expect(waitStub.calledTwice).to.be.true;
      expect(waitStub.firstCall.args[0]).to.equal(0);
      expect(waitStub.secondCall.args[0]).to.equal(1);
    });

    it('should not timeout when timeoutMs is 0', async () => {
      const mockReceipt = {
        transactionHash: '0xabc123def456',
        blockNumber: 100,
        status: 1,
      } as unknown as ProtocolReceipt<any>;

      const mockTx = {
        hash: '0xabc123def456',
        wait: sinon.stub().callsFake(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(mockReceipt), 50);
            }),
        ),
      } as unknown as ProtocolTransaction<any>;

      const result = await multiProvider.handleTx(TestChainName.test1, mockTx, {
        timeoutMs: 0,
      });

      expect(result).to.deep.equal(mockReceipt);
    });

    it('should apply default timeout when no options provided', async () => {
      const mockTx = {
        hash: '0xabc123def456',
        wait: sinon.stub().returns(new Promise(() => {})),
      } as unknown as ProtocolTransaction<any>;

      try {
        await Promise.race([
          multiProvider.handleTx(TestChainName.test1, mockTx),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Test timeout')), 100),
          ),
        ]);
        throw new Error('Expected timeout error');
      } catch (error: any) {
        expect(error.message).to.match(/Timeout|Test timeout/);
      }
    });

    it('should apply minimum timeout floor for short estimateBlockTime', async () => {
      const chainMetadataWithBlockTime = {
        [TestChainName.test1]: {
          ...test1,
          blocks: {
            ...test1.blocks,
            confirmations: 1,
            estimateBlockTime: 0.02,
          },
        },
        [TestChainName.test2]: test2,
      };
      const mp = new MultiProvider(chainMetadataWithBlockTime);
      const mockTx = {
        hash: '0xabc123def456',
        wait: sinon.stub().returns(new Promise(() => {})),
      } as unknown as ProtocolTransaction<any>;
      // Raw timeout: 1 × 0.02s × 1000 × 2 = 40ms
      // With floor: max(40, 30000) = 30000ms
      // Race against 200ms — if the floor works, 200ms timer wins (not a Timeout error)
      try {
        await Promise.race([
          mp.handleTx(TestChainName.test1, mockTx),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Race timer')), 200),
          ),
        ]);
        throw new Error('Expected race timer');
      } catch (error: any) {
        // Without the floor, handleTx would timeout at 40ms with "Timeout" error.
        // With the floor, the 200ms race timer fires first.
        expect(error.message).to.equal('Race timer');
      }
    });

    it('should dispatch to waitForBlockTag for string confirmation', async () => {
      const mockReceipt = {
        transactionHash: '0xabc123def456',
        blockNumber: 100,
        status: 1,
      } as unknown as ProtocolReceipt<any>;

      const mockTx = {
        hash: '0xabc123def456',
        wait: sinon.stub().resolves(mockReceipt),
      } as unknown as ProtocolTransaction<any>;

      const waitForBlockTagStub = sinon
        .stub(multiProvider, 'waitForBlockTag')
        .resolves(mockReceipt);

      const result = await multiProvider.handleTx(TestChainName.test1, mockTx, {
        waitConfirmations: EthJsonRpcBlockParameterTag.Finalized,
      });

      expect(result).to.deep.equal(mockReceipt);
      expect(waitForBlockTagStub.calledOnce).to.be.true;

      waitForBlockTagStub.restore();
    });
  });
});
