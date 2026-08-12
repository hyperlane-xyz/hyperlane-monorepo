import { expect } from 'chai';
import { BigNumber, Contract, ContractFactory, Wallet } from 'ethers';
import type { ContractTransaction } from 'ethers';
import {
  Provider as ZKSyncProvider,
  Wallet as ZKSyncWallet,
} from 'zksync-ethers';

import {
  Mailbox__factory,
  ProxyAdmin__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import type { ZKSyncArtifact } from '@hyperlane-xyz/core';
import {
  Mailbox__factory as TronMailbox__factory,
  ProxyAdmin__factory as TronProxyAdmin__factory,
  TronContractFactory,
  TestRecipient__factory as TronTestRecipient__factory,
} from '@hyperlane-xyz/tron-sdk';
import { TestChainName, test1, test2 } from '../consts/testChains.js';
import type { ProtocolTransaction, ProtocolReceipt } from './ProviderType.js';
import {
  ChainTechnicalStack,
  EthJsonRpcBlockParameterTag,
} from '../metadata/chainMetadataTypes.js';
import sinon from 'sinon';

import { MultiProvider } from './MultiProvider.js';

describe('MultiProvider Tron factory resolution', () => {
  const mp = new MultiProvider({});

  it('resolves Mailbox to tron factory with different bytecode', async () => {
    const resolved = await mp.resolveTronFactory(new Mailbox__factory());
    expect(resolved.constructor.name).to.equal(TronContractFactory.name);
    expect(resolved.bytecode).to.equal(new TronMailbox__factory().bytecode);
    expect(resolved.bytecode).to.not.equal(new Mailbox__factory().bytecode);
  });

  it('resolves ProxyAdmin to tron factory', async () => {
    const resolved = await mp.resolveTronFactory(new ProxyAdmin__factory());
    expect(resolved.constructor.name).to.equal(TronContractFactory.name);
    expect(resolved.bytecode).to.equal(new TronProxyAdmin__factory().bytecode);
  });

  it('resolves TestRecipient to tron factory', async () => {
    const resolved = await mp.resolveTronFactory(new TestRecipient__factory());
    expect(resolved.constructor.name).to.equal(TronContractFactory.name);
    expect(resolved.bytecode).to.equal(
      new TronTestRecipient__factory().bytecode,
    );
  });

  it('preserves ABI when resolving', async () => {
    const resolved = await mp.resolveTronFactory(new Mailbox__factory());
    expect(JSON.stringify(resolved.interface.fragments)).to.equal(
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
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('No Tron-compiled factory found for');
    }
  });
});

describe('MultiProvider', () => {
  describe('handleDeploy', () => {
    afterEach(() => sinon.restore());

    it('delegates zkSync deployments through the dynamically loaded deployer', async () => {
      const zkSyncChain = 'testzksync';
      const multiProvider = new MultiProvider({
        [zkSyncChain]: {
          ...test1,
          chainId: 260,
          displayName: 'Test zkSync',
          domainId: 260,
          name: zkSyncChain,
          technicalStack: ChainTechnicalStack.ZkSync,
        },
      });
      const zkSyncSigner = new ZKSyncWallet(
        Wallet.createRandom().privateKey,
        new ZKSyncProvider(test1.rpcUrls[0].http),
      );
      const connect = sinon.spy(zkSyncSigner, 'connect');
      multiProvider.setSigner(zkSyncChain, zkSyncSigner);

      const artifact = {
        _format: 'hh-zksolc-artifact-1',
        abi: [],
        bytecode: '0x00',
        contractName: 'TestContract',
        deployedBytecode: '0x00',
        deployedLinkReferences: {},
        factoryDeps: {},
        linkReferences: {},
        sourceName: 'TestContract.sol',
      } satisfies ZKSyncArtifact;
      const params = ['constructor-param'];
      const deployedContract = new Contract(
        '0x0000000000000000000000000000000000001234',
        [],
        zkSyncSigner,
      );
      const { ZKSyncDeployer } = await import('../zksync/ZKSyncDeployer.js');
      const estimateDeployGas = sinon
        .stub(ZKSyncDeployer.prototype, 'estimateDeployGas')
        .resolves(BigNumber.from(100_000));
      const deploy = sinon
        .stub(ZKSyncDeployer.prototype, 'deploy')
        .resolves(deployedContract);

      const result = await multiProvider.handleDeploy(
        zkSyncChain,
        new ContractFactory([], '0x'),
        params,
        artifact,
      );

      expect(result).to.equal(deployedContract);
      expect(connect.calledOnceWithExactly(zkSyncSigner.provider)).to.be.true;
      expect(estimateDeployGas.calledOnceWithExactly(artifact, params)).to.be
        .true;
      expect(deploy.calledOnce).to.be.true;
      expect(deploy.firstCall.args[0]).to.equal(artifact);
      expect(deploy.firstCall.args[1]).to.equal(params);
      expect(BigNumber.from(deploy.firstCall.args[2]?.gasLimit).gt(100_000)).to
        .be.true;
    });
  });

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

    it('should wait for inclusion when zero confirmations are requested', async () => {
      const mockReceipt = {
        transactionHash: '0xabc123def456',
        blockNumber: 100,
        status: 1,
      } as unknown as ProtocolReceipt<any>;

      const waitStub = sinon.stub();
      waitStub.withArgs(0).resolves(mockReceipt);
      waitStub.withArgs(1).returns(new Promise(() => {}));
      const receiptProbe = sinon
        .stub(
          multiProvider.getProvider(TestChainName.test1),
          'getTransactionReceipt',
        )
        .onFirstCall()
        .resolves(undefined);
      receiptProbe.onSecondCall().resolves(mockReceipt);

      const mockTx = {
        hash: '0xabc123def456',
        wait: waitStub,
      } as unknown as ProtocolTransaction<any>;

      const result = await multiProvider.handleTx(TestChainName.test1, mockTx, {
        waitConfirmations: 0,
        timeoutMs: 5000,
      });

      expect(result).to.deep.equal(mockReceipt);
      expect(receiptProbe.calledTwice).to.be.true;
      expect(waitStub.withArgs(0).calledOnce).to.be.true;
      expect(waitStub.withArgs(1).calledOnce).to.be.true;
    });

    for (const { reason, cancelled } of [
      { reason: 'cancelled', cancelled: true },
      { reason: 'repriced', cancelled: false },
    ] as const) {
      it(`should propagate ${reason} transaction replacements`, async () => {
        const replacementReceipt = {
          transactionHash: '0xreplacement',
          blockNumber: 101,
          status: 1,
        };
        const replacementError = Object.assign(
          new Error('transaction was replaced'),
          {
            code: 'TRANSACTION_REPLACED',
            reason,
            cancelled,
            receipt: replacementReceipt,
          },
        );
        const waitStub = sinon.stub();
        waitStub.withArgs(1).rejects(replacementError);
        const receiptProbe = sinon
          .stub(
            multiProvider.getProvider(TestChainName.test1),
            'getTransactionReceipt',
          )
          .resolves(undefined);
        // CAST: handleTx only reads hash and wait; a complete ethers transaction
        // would add unrelated fields to this focused replacement-error test.
        const mockTx = {
          hash: '0xabc123def456',
          wait: waitStub,
        } as unknown as ContractTransaction;

        try {
          await multiProvider.handleTx(TestChainName.test1, mockTx, {
            waitConfirmations: 0,
            timeoutMs: 5000,
          });
          expect.fail('Expected transaction replacement error');
        } catch (error) {
          expect(error).to.equal(replacementError);
          expect(replacementError.reason).to.equal(reason);
          expect(replacementError.receipt).to.equal(replacementReceipt);
          expect(receiptProbe.called).to.be.true;
          expect(waitStub.withArgs(0).notCalled).to.be.true;
        }
      });
    }

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
      expect(result1).to.equal(mockConnectedSigner);
      expect(connectCallCount).to.equal(1);

      // Second call should return cached signer without calling connect again
      const result2 = mp.tryGetSigner(TestChainName.test1);
      expect(result2).to.equal(mockConnectedSigner);
      expect(connectCallCount).to.equal(1);
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
      expect(connectArg).to.equal(oldProvider);
      expect(result1!.provider).to.equal(oldProvider);

      // Swap provider — in shared mode, setProvider skips reconnection
      mp.providers[TestChainName.test1] = newProvider;

      // Second call should reconnect to new provider (not return stale cached signer)
      const result2 = mp.tryGetSigner(TestChainName.test1);
      expect(connectArg).to.equal(newProvider);
      expect(result2!.provider).to.equal(newProvider);
    });
  });
});
