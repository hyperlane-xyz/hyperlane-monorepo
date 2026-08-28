import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import { HyperlaneCore } from '@hyperlane-xyz/sdk';

import type { Erc20ContractFactory } from '../bridges/erc20Approve.js';
import {
  TEST_ADDRESSES,
  buildTestMovableCollateralRoute,
  createRebalancerTestContext,
} from '../test/helpers.js';
import type { IActionTracker } from '../tracking/IActionTracker.js';

import { Rebalancer } from './Rebalancer.js';

function createMockActionTracker(): IActionTracker {
  return {
    initialize: Sinon.stub().resolves(),
    createRebalanceIntent: Sinon.stub().callsFake(async () => ({
      id: `intent-${Date.now()}`,
      status: 'not_started',
    })),
    createRebalanceAction: Sinon.stub().resolves(),
    completeRebalanceAction: Sinon.stub().resolves(),
    failRebalanceAction: Sinon.stub().resolves(),
    completeRebalanceIntent: Sinon.stub().resolves(),
    cancelRebalanceIntent: Sinon.stub().resolves(),
    failRebalanceIntent: Sinon.stub().resolves(),
    syncTransfers: Sinon.stub().resolves(),
    syncRebalanceIntents: Sinon.stub().resolves(),
    syncRebalanceActions: Sinon.stub().resolves(),
    syncInventoryMovementActions: Sinon.stub().resolves({
      completed: 0,
      failed: 0,
    }),
    logStoreContents: Sinon.stub().resolves(),
    getInProgressTransfers: Sinon.stub().resolves([]),
    getActiveRebalanceIntents: Sinon.stub().resolves([]),
    getTransfersByDestination: Sinon.stub().resolves([]),
    getRebalanceIntentsByDestination: Sinon.stub().resolves([]),
    getTransfer: Sinon.stub().resolves(undefined),
    getRebalanceIntent: Sinon.stub().resolves(undefined),
    getRebalanceAction: Sinon.stub().resolves(undefined),
    getInProgressActions: Sinon.stub().resolves([]),
    getPartiallyFulfilledInventoryIntents: Sinon.stub().resolves([]),
    getActionsByType: Sinon.stub().resolves([]),
    getActionsForIntent: Sinon.stub().resolves([]),
    getInflightInventoryMovements: Sinon.stub().resolves(0n),
  };
}

chai.use(chaiAsPromised);

const testLogger = pino({ level: 'silent' });

interface TestApprovalTransaction {
  hash: string;
  wait: Sinon.SinonStub<[], Promise<{ status: number }>>;
}

class StatefulErc20Contract extends ethers.Contract {
  allowanceValue: ethers.BigNumber;
  readonly allowanceStub = Sinon.stub<
    [string, string],
    Promise<ethers.BigNumber>
  >();
  readonly approveStub = Sinon.stub<
    [string, ethers.BigNumberish],
    Promise<TestApprovalTransaction>
  >();

  constructor(
    address: string,
    signer: ethers.Signer,
    initialAllowance: ethers.BigNumberish = 0,
  ) {
    super(address, [], signer);
    this.allowanceValue = ethers.BigNumber.from(initialAllowance);
    this.allowanceStub.callsFake(async () => this.allowanceValue);
    this.approveStub.callsFake(async (_spender, amount) => {
      const target = ethers.BigNumber.from(amount);
      const wait = Sinon.stub<[], Promise<{ status: number }>>().callsFake(
        async () => {
          this.allowanceValue = target;
          return { status: 1 };
        },
      );
      return {
        hash: `0xapproval${this.approveStub.callCount}`,
        wait,
      };
    });
  }

  allowance(owner: string, spender: string): Promise<ethers.BigNumber> {
    return this.allowanceStub(owner, spender);
  }

  approve(
    spender: string,
    amount: ethers.BigNumberish,
  ): Promise<TestApprovalTransaction> {
    return this.approveStub(spender, amount);
  }
}

function createApprovalHarness(
  initialAllowances: Record<string, ethers.BigNumberish> = {},
  failingApprovalTokens: string[] = [],
  failingCleanupTokens: string[] = [],
): {
  contractFactory: Erc20ContractFactory;
  getContract: (token: string) => StatefulErc20Contract;
} {
  const contracts = new Map<string, StatefulErc20Contract>();
  const contractFactory: Erc20ContractFactory = (token, _abi, signer) => {
    const key = token.toLowerCase();
    let contract = contracts.get(key);
    if (!contract) {
      contract = new StatefulErc20Contract(
        token,
        signer,
        initialAllowances[key] ?? 0,
      );
      if (failingApprovalTokens.some((value) => value.toLowerCase() === key)) {
        contract.approveStub.onCall(0).rejects(new Error('approval failed'));
      } else if (
        failingCleanupTokens.some((value) => value.toLowerCase() === key)
      ) {
        contract.approveStub.onCall(1).rejects(new Error('cleanup failed'));
      }
      contracts.set(key, contract);
    }
    return contract;
  };

  return {
    contractFactory,
    getContract: (token) => {
      const contract = contracts.get(token.toLowerCase());
      if (!contract) throw new Error(`No approval contract for ${token}`);
      return contract;
    },
  };
}

function createApprovalRebalancer(
  ctx: ReturnType<typeof createRebalancerTestContext>,
  contractFactory: Erc20ContractFactory,
): Rebalancer {
  return new Rebalancer(
    ctx.warpCore,
    ctx.chainMetadata,
    ctx.tokensByChainName,
    ctx.multiProvider,
    createMockActionTracker(),
    testLogger,
    undefined,
    { contractFactory },
  );
}

describe('Rebalancer', () => {
  let sandbox: Sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('rebalance()', () => {
    it('should return empty array for empty routes', async () => {
      const ctx = createRebalancerTestContext();
      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const results = await rebalancer.rebalance([]);

      expect(results).to.deep.equal([]);
    });

    it('should return success result for single valid route', async () => {
      const ctx = createRebalancerTestContext();

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
    });

    it('should return failure results for routes that fail preparation', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { isRebalancer: false },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should handle mixed success and failure results', async () => {
      const ctx = createRebalancerTestContext(
        ['ethereum', 'arbitrum', 'optimism'],
        {
          ethereum: { isRebalancer: true },
          optimism: { isRebalancer: false },
        },
      );

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        {
          ...ctx.chainMetadata,
          optimism: {
            ...ctx.chainMetadata.ethereum,
            name: 'optimism',
            domainId: 10,
          } as any,
        },
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
        }),
        buildTestMovableCollateralRoute({
          origin: 'optimism',
          destination: 'arbitrum',
        }),
      ];

      const results = await rebalancer.rebalance(routes);

      expect(results).to.have.lengthOf(2);
      const successResults = results.filter((r) => r.success);
      const failureResults = results.filter((r) => !r.success);
      expect(successResults).to.have.lengthOf(1);
      expect(failureResults).to.have.lengthOf(1);
    });
  });

  describe('validateRoute()', () => {
    it('should fail when origin token not found', async () => {
      const ctx = createRebalancerTestContext(['arbitrum']);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('null');
    });

    it('should fail when destination token not found', async () => {
      const ctx = createRebalancerTestContext(['ethereum']);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should log scaled route amounts using origin local units', async () => {
      const ctx = createRebalancerTestContext(['ethereum']);
      ctx.tokensByChainName.ethereum.scale = {
        numerator: 1,
        denominator: 1_000_000_000_000,
      };

      const logger = {
        child: Sinon.stub(),
        info: Sinon.stub(),
        warn: Sinon.stub(),
        error: Sinon.stub(),
      };
      logger.child.returns(logger);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        logger as any,
      );

      const route = buildTestMovableCollateralRoute({
        origin: 'ethereum',
        destination: 'arbitrum',
        amount: 1_000_000n,
      });
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      const validationErrorCall = logger.error
        .getCalls()
        .find(
          (call) =>
            call.args[1] ===
            'Route validation failed: destination token not found.',
        );
      expect(validationErrorCall).to.not.be.undefined;
      expect(validationErrorCall!.args[0].amount).to.equal(1);
      expect(validationErrorCall!.args[1]).to.equal(
        'Route validation failed: destination token not found.',
      );
    });

    it('should fail when signer is not a rebalancer', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { isRebalancer: false },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should fail when destination is not in allowed list', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: {
          allowedDestination: '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
        },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should fail when bridge is not allowed', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { isBridgeAllowed: false },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });
  });

  describe('prepareTransactions()', () => {
    it('should create failure result when quote fetching throws', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { throwOnQuotes: new Error('Quote fetch failed') },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should create failure result when tx population throws', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: { throwOnPopulate: new Error('Populate failed') },
      });

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
    });

    it('should denormalize canonical route amounts before quote and populate calls', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.tokensByChainName.ethereum.scale = {
        numerator: 1,
        denominator: 1_000_000_000_000,
      };

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      await rebalancer.rebalance([
        buildTestMovableCollateralRoute({
          amount: 1_000_000n,
        }),
      ]);

      expect(ctx.adapters.ethereum.getRebalanceQuotes.calledOnce).to.be.true;
      expect(
        ctx.adapters.ethereum.getRebalanceQuotes.firstCall.args[3],
      ).to.equal(1_000_000_000_000_000_000n);
      expect(
        ctx.adapters.ethereum.populateRebalanceTx.firstCall.args[1],
      ).to.equal(1_000_000_000_000_000_000n);
    });
  });

  describe('collateral fee approvals', () => {
    const collateralA = TEST_ADDRESSES.token;
    const collateralB = TEST_ADDRESSES.polygon;

    function stubSuccessfulSettlement(): void {
      // CAST: tests only need the message ID consumed by buildResult.
      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);
    }

    function feeQuote(token: string, total: bigint) {
      return [{ igpQuote: { addressOrDenom: token, amount: total } }];
    }

    it('approves the exact aggregate for a same-router batch', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: {
          wrappedTokenAddress: collateralA,
          quotes: feeQuote(collateralA, 103n),
        },
      });
      const harness = createApprovalHarness();
      const rebalancer = createApprovalRebalancer(ctx, harness.contractFactory);
      stubSuccessfulSettlement();

      const results = await rebalancer.rebalance([
        buildTestMovableCollateralRoute({ amount: 100n }),
        buildTestMovableCollateralRoute({ amount: 100n }),
      ]);

      expect(results.every((result) => result.success)).to.equal(true);
      const amounts = harness
        .getContract(collateralA)
        .approveStub.getCalls()
        .map((call) => ethers.BigNumber.from(call.args[1]).toString());
      expect(amounts).to.deep.equal(['6', '0']);
      expect(amounts).not.to.include(ethers.constants.MaxUint256.toString());
    });

    it('zero-resets a prior allowance before setting the exact fee', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: {
          wrappedTokenAddress: collateralA,
          quotes: feeQuote(collateralA, 103n),
        },
      });
      const harness = createApprovalHarness({
        [collateralA.toLowerCase()]: 99,
      });
      const rebalancer = createApprovalRebalancer(ctx, harness.contractFactory);
      stubSuccessfulSettlement();

      const results = await rebalancer.rebalance([
        buildTestMovableCollateralRoute({ amount: 100n }),
      ]);

      expect(results[0].success).to.equal(true);
      const amounts = harness
        .getContract(collateralA)
        .approveStub.getCalls()
        .map((call) => ethers.BigNumber.from(call.args[1]).toString());
      expect(amounts).to.deep.equal(['0', '3', '0']);
    });

    it('cleans approval residue when a higher quote fails estimation', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: {
          wrappedTokenAddress: collateralA,
          quotes: feeQuote(collateralA, 103n),
        },
      });
      ctx.multiProvider.estimateGas = Sinon.stub().rejects(
        new Error('quote increased above exact allowance'),
      );
      const harness = createApprovalHarness();
      const rebalancer = createApprovalRebalancer(ctx, harness.contractFactory);

      const results = await rebalancer.rebalance([
        buildTestMovableCollateralRoute({ amount: 100n }),
      ]);

      expect(results[0].success).to.equal(false);
      expect(results[0].error).to.include('quote increased');
      const contract = harness.getContract(collateralA);
      expect(contract.allowanceValue.isZero()).to.equal(true);
      const amounts = contract.approveStub
        .getCalls()
        .map((call) => ethers.BigNumber.from(call.args[1]).toString());
      expect(amounts).to.deep.equal(['3', '0']);
    });

    it('isolates one approval failure from another origin', async () => {
      const ctx = createRebalancerTestContext(
        ['ethereum', 'arbitrum', 'optimism'],
        {
          ethereum: {
            wrappedTokenAddress: collateralA,
            quotes: feeQuote(collateralA, 103n),
          },
          optimism: {
            wrappedTokenAddress: collateralB,
            quotes: feeQuote(collateralB, 104n),
          },
        },
      );
      const harness = createApprovalHarness({}, [collateralA]);
      const rebalancer = createApprovalRebalancer(ctx, harness.contractFactory);
      stubSuccessfulSettlement();

      const results = await rebalancer.rebalance([
        buildTestMovableCollateralRoute({ amount: 100n }),
        buildTestMovableCollateralRoute({
          origin: 'optimism',
          destination: 'arbitrum',
          amount: 100n,
        }),
      ]);

      const ethereumResult = results.find(
        (result) => result.route.origin === 'ethereum',
      );
      const optimismResult = results.find(
        (result) => result.route.origin === 'optimism',
      );
      expect(ethereumResult?.success).to.equal(false);
      expect(ethereumResult?.error).to.include('approval failed');
      expect(optimismResult?.success).to.equal(true);
    });

    it('revokes residue after a partial same-origin send failure', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: {
          wrappedTokenAddress: collateralA,
          quotes: feeQuote(collateralA, 103n),
        },
      });
      const harness = createApprovalHarness();
      let sends = 0;
      ctx.multiProvider.sendTransaction = Sinon.stub().callsFake(async () => {
        sends += 1;
        if (sends === 1) {
          const contract = harness.getContract(collateralA);
          contract.allowanceValue = contract.allowanceValue.sub(3);
          return {
            transactionHash:
              '0xTxHash1111111111111111111111111111111111111111111111111111111111',
            blockNumber: 100,
            status: 1,
          };
        }
        throw new Error('second send failed');
      });
      const rebalancer = createApprovalRebalancer(ctx, harness.contractFactory);
      stubSuccessfulSettlement();

      const results = await rebalancer.rebalance([
        buildTestMovableCollateralRoute({ amount: 100n }),
        buildTestMovableCollateralRoute({ amount: 100n }),
      ]);

      expect(results.filter((result) => result.success)).to.have.lengthOf(1);
      expect(results.filter((result) => !result.success)).to.have.lengthOf(1);
      const contract = harness.getContract(collateralA);
      expect(contract.allowanceValue.isZero()).to.equal(true);
      const amounts = contract.approveStub
        .getCalls()
        .map((call) => ethers.BigNumber.from(call.args[1]).toString());
      expect(amounts).to.deep.equal(['6', '0']);
    });

    it('does not replace a successful send result with cleanup failure', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
        ethereum: {
          wrappedTokenAddress: collateralA,
          quotes: feeQuote(collateralA, 103n),
        },
      });
      const harness = createApprovalHarness({}, [], [collateralA]);
      const rebalancer = createApprovalRebalancer(ctx, harness.contractFactory);
      stubSuccessfulSettlement();

      const results = await rebalancer.rebalance([
        buildTestMovableCollateralRoute({ amount: 100n }),
      ]);

      expect(results[0].success).to.equal(true);
      expect(harness.getContract(collateralA).allowanceValue.eq(3)).to.equal(
        true,
      );
    });
  });

  describe('executeTransactions()', () => {
    it('should create failure result when gas estimation fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.multiProvider.estimateGas = Sinon.stub().rejects(
        new Error('Gas estimation failed'),
      );

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Gas estimation failed');
    });

    it('should continue with other routes when one fails gas estimation', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      let callCount = 0;
      ctx.multiProvider.estimateGas = Sinon.stub().callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Gas estimation failed'));
        }
        return Promise.resolve(ethers.BigNumber.from(100000));
      });

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        {
          ...ctx.chainMetadata,
          optimism: {
            ...ctx.chainMetadata.ethereum,
            name: 'optimism',
            domainId: 10,
          } as any,
        },
        { ...ctx.tokensByChainName, optimism: ctx.tokensByChainName.ethereum },
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
        }),
        buildTestMovableCollateralRoute({
          origin: 'optimism',
          destination: 'arbitrum',
        }),
      ];

      const results = await rebalancer.rebalance(routes);

      expect(results).to.have.lengthOf(2);
      const failures = results.filter((r) => !r.success);
      const successes = results.filter((r) => r.success);
      expect(failures).to.have.lengthOf(1);
      expect(successes).to.have.lengthOf(1);
    });

    it('should group transactions by origin chain', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      let sendCallCount = 0;
      (ctx.multiProvider.sendTransaction as Sinon.SinonStub).callsFake(() => {
        sendCallCount++;
        return Promise.resolve({
          transactionHash: `0x${sendCallCount.toString().padStart(64, '0')}`,
          blockNumber: 100,
          status: 1,
        });
      });

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
        }),
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'optimism',
        }),
        buildTestMovableCollateralRoute({
          origin: 'optimism',
          destination: 'arbitrum',
        }),
      ];

      await rebalancer.rebalance(routes);

      expect(sendCallCount).to.equal(3);
    });
  });

  describe('sendTransactionsForChain()', () => {
    it('should return error result when send fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
      ctx.multiProvider.sendTransaction = Sinon.stub().rejects(
        new Error('Send failed'),
      );

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('Send failed');
    });

    it('should continue sending remaining transactions after one fails', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      let callCount = 0;
      ctx.multiProvider.sendTransaction = Sinon.stub().callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('First send failed'));
        }
        return Promise.resolve({
          transactionHash:
            '0xTxHash2222222222222222222222222222222222222222222222222222222222',
          blockNumber: 100,
          status: 1,
        });
      });

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0xMessageId111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          amount: ethers.utils.parseEther('100').toBigInt(),
        }),
        buildTestMovableCollateralRoute({
          amount: ethers.utils.parseEther('200').toBigInt(),
        }),
      ];

      const results = await rebalancer.rebalance(routes);

      expect(results).to.have.lengthOf(2);
      expect(results.filter((r) => !r.success)).to.have.lengthOf(1);
      expect(results.filter((r) => r.success)).to.have.lengthOf(1);
    });

    it('should send transactions sequentially within same origin chain', async () => {
      const ctx = createRebalancerTestContext([
        'ethereum',
        'arbitrum',
        'optimism',
      ]);

      const callOrder: string[] = [];
      ctx.multiProvider.sendTransaction = Sinon.stub().callsFake(
        async (chain: string) => {
          callOrder.push(chain);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            transactionHash: `0x${callOrder.length.toString().padStart(64, '0')}`,
            blockNumber: 100,
            status: 1,
          };
        },
      );

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const routes = [
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'arbitrum',
          amount: ethers.utils.parseEther('100').toBigInt(),
        }),
        buildTestMovableCollateralRoute({
          origin: 'ethereum',
          destination: 'optimism',
          amount: ethers.utils.parseEther('200').toBigInt(),
        }),
      ];

      await rebalancer.rebalance(routes);

      expect(callOrder).to.deep.equal(['ethereum', 'ethereum']);
    });
  });

  describe('result building', () => {
    it('should include messageId when dispatch message found', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      const expectedMessageId =
        '0xMessageId111111111111111111111111111111111111111111111111111111';
      sandbox
        .stub(HyperlaneCore, 'getDispatchedMessages')
        .returns([{ id: expectedMessageId } as any]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.true;
      expect(results[0].messageId).to.equal(expectedMessageId);
    });

    it('should return success: false when no Dispatch event found', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].success).to.be.false;
      expect(results[0].error).to.include('no Dispatch event found');
      expect(results[0].messageId).to.equal('');
    });

    it('should include txHash in result', async () => {
      const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);

      const expectedTxHash =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      sandbox.stub(HyperlaneCore, 'getDispatchedMessages').returns([
        {
          id: '0x2222222222222222222222222222222222222222222222222222222222222222',
        } as any,
      ]);

      const rebalancer = new Rebalancer(
        ctx.warpCore,
        ctx.chainMetadata,
        ctx.tokensByChainName,
        ctx.multiProvider as any,
        createMockActionTracker(),
        testLogger,
      );

      const route = buildTestMovableCollateralRoute();
      const results = await rebalancer.rebalance([route]);

      expect(results).to.have.lengthOf(1);
      expect(results[0].txHash).to.equal(expectedTxHash);
    });
  });
});
