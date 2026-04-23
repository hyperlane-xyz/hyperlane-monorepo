import { expect } from 'vitest';
import { ContractFactory } from 'ethers';

import {
  Mailbox__factory,
  ProxyAdmin__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  Mailbox__factory as TronMailbox__factory,
  ProxyAdmin__factory as TronProxyAdmin__factory,
  TronContractFactory,
  TestRecipient__factory as TronTestRecipient__factory,
} from '@hyperlane-xyz/tron-sdk';
import { TestChainName, test1, test2 } from '../consts/testChains.js';
import type { ProtocolTransaction, ProtocolReceipt } from './ProviderType.js';
import { EthJsonRpcBlockParameterTag } from '../metadata/chainMetadataTypes.js';
import sinon from 'sinon';

import { MultiProvider } from './MultiProvider.js';

describe('MultiProvider Tron factory resolution', () => {
  const mp = new MultiProvider({});

  it('resolves Mailbox to tron factory with different bytecode', async () => {
    const resolved = await mp.resolveTronFactory(new Mailbox__factory());
    expect(resolved.constructor.name).toBe(TronContractFactory.name);
    expect(resolved.bytecode).toBe(new TronMailbox__factory().bytecode);
    expect(resolved.bytecode).not.toBe(new Mailbox__factory().bytecode);
  });

  it('resolves ProxyAdmin to tron factory', async () => {
    const resolved = await mp.resolveTronFactory(new ProxyAdmin__factory());
    expect(resolved.constructor.name).toBe(TronContractFactory.name);
    expect(resolved.bytecode).toBe(new TronProxyAdmin__factory().bytecode);
  });

  it('resolves TestRecipient to tron factory', async () => {
    const resolved = await mp.resolveTronFactory(new TestRecipient__factory());
    expect(resolved.constructor.name).toBe(TronContractFactory.name);
    expect(resolved.bytecode).toBe(new TronTestRecipient__factory().bytecode);
  });

  it('preserves ABI when resolving', async () => {
    const resolved = await mp.resolveTronFactory(new Mailbox__factory());
    expect(JSON.stringify(resolved.interface.fragments)).toBe(
      JSON.stringify(new Mailbox__factory().interface.fragments),
    );
  });

  it('throws for unknown factory', async () => {
    class Unknown__factory extends ContractFactory {
      constructor() {
        super([], '0x');
      }
    }
    try {
      await mp.resolveTronFactory(new Unknown__factory());
      throw new Error('Should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('No Tron-compiled factory found for');
    }
  });
});

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
        expect(error.message).toContain('Timeout');
        expect(error.message).toContain('0xabc123def456');
        expect(error.message).toContain('confirmations');
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

      expect(result).toEqual(mockReceipt);
      expect(mockTx.wait.calledOnce).toBe(true);
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

      expect(result).toEqual(mockReceipt);
      expect(waitStub.calledTwice).toBe(true);
      expect(waitStub.firstCall.args[0]).toBe(0);
      expect(waitStub.secondCall.args[0]).toBe(1);
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

      expect(result).toEqual(mockReceipt);
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
        expect(error.message).toMatch(/Timeout|Test timeout/);
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
        expect(error.message).toBe('Race timer');
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

      expect(result).toEqual(mockReceipt);
      expect(waitForBlockTagStub.calledOnce).toBe(true);

      waitForBlockTagStub.restore();
    });
  });

  describe('tryGetSigner', () => {
    it('should cache the connected signer for subsequent calls', () => {
      const chainMetadata = {
        [TestChainName.test1]: test1,
        [TestChainName.test2]: test2,
      };
      const mp = new MultiProvider(chainMetadata);

      let connectCallCount = 0;
      const mockProvider = {} as any;
      const mockConnectedSigner = { provider: mockProvider } as any;
      const mockSigner = {
        provider: undefined,
        connect: sinon.stub().callsFake(() => {
          connectCallCount += 1;
          return mockConnectedSigner;
        }),
      } as any;

      mp.signers[TestChainName.test1] = mockSigner;
      mp.providers[TestChainName.test1] = mockProvider;

      // First call should connect and cache
      const result1 = mp.tryGetSigner(TestChainName.test1);
      expect(result1).toBe(mockConnectedSigner);
      expect(connectCallCount).toBe(1);

      // Second call should return cached signer without calling connect again
      const result2 = mp.tryGetSigner(TestChainName.test1);
      expect(result2).toBe(mockConnectedSigner);
      expect(connectCallCount).toBe(1);
    });

    it('should not cache signer in shared-signer mode so provider swaps take effect', () => {
      const chainMetadata = {
        [TestChainName.test1]: test1,
        [TestChainName.test2]: test2,
      };
      const mp = new MultiProvider(chainMetadata);

      const oldProvider = {} as any;
      const newProvider = {} as any;

      let connectArg: any;
      const mockSigner = {
        provider: undefined,
        connect: sinon.stub().callsFake((p: any) => {
          connectArg = p;
          return { provider: p, getAddress: () => '0x1' } as any;
        }),
      } as any;

      // Use shared signer mode
      mp.useSharedSigner = true;
      mp.signers[TestChainName.test1] = mockSigner;
      mp.providers[TestChainName.test1] = oldProvider;

      // First call connects to old provider
      const result1 = mp.tryGetSigner(TestChainName.test1);
      expect(connectArg).toBe(oldProvider);
      expect(result1!.provider).toBe(oldProvider);

      // Swap provider — in shared mode, setProvider skips reconnection
      mp.providers[TestChainName.test1] = newProvider;

      // Second call should reconnect to new provider (not return stale cached signer)
      const result2 = mp.tryGetSigner(TestChainName.test1);
      expect(connectArg).toBe(newProvider);
      expect(result2!.provider).toBe(newProvider);
    });
  });
});
