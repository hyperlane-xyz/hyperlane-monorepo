import { expect } from 'chai';
import { type providers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import { HyperlaneCore, type MultiProvider } from '@hyperlane-xyz/sdk';

import type { IActionTracker } from '../../tracking/IActionTracker.js';
import {
  buildTestMovableCollateralRoute,
  buildTestPreparedTransaction,
  createRebalancerTestContext,
  TEST_ADDRESSES,
} from '../../test/helpers.js';
import { MovableChainTransactionExecutor } from './ChainTransactionExecutor.js';
import { MovableResultRecorder } from './ResultRecorder.js';
import { MovableRouteValidator } from './RouteValidator.js';
import { MovableTransactionPreparer } from './TransactionPreparer.js';
import type {
  MovableInternalExecutionResult,
  MovableInternalRoute,
} from './types.js';

const testLogger = pino({ level: 'silent' });

function buildInternalRoute(
  overrides: Partial<MovableInternalRoute> = {},
): MovableInternalRoute {
  return {
    ...buildTestMovableCollateralRoute(),
    intentId: 'intent-1',
    ...overrides,
  };
}

function createActionTrackerStub(): IActionTracker {
  return {
    createRebalanceAction: Sinon.stub().resolves(),
    failRebalanceIntent: Sinon.stub().resolves(),
  } as unknown as IActionTracker;
}

describe('movable collateral execution modules', () => {
  let sandbox: Sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('validates route bridge permission against destination domain', async () => {
    const ctx = createRebalancerTestContext(['ethereum', 'arbitrum'], {
      ethereum: { isBridgeAllowed: false },
    });
    const validator = new MovableRouteValidator(
      ctx.warpCore,
      ctx.chainMetadata,
      ctx.tokensByChainName,
      ctx.multiProvider as unknown as MultiProvider,
      testLogger,
    );

    const isValid = await validator.validate(buildInternalRoute());

    expect(isValid).to.be.false;
    expect(
      ctx.adapters.ethereum.isBridgeAllowed.calledOnceWithExactly(
        ctx.chainMetadata.arbitrum.domainId,
        TEST_ADDRESSES.bridge,
      ),
    ).to.be.true;
  });

  it('prepares transactions using origin-local denormalized amounts', async () => {
    const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
    ctx.tokensByChainName.ethereum.scale = {
      numerator: 1,
      denominator: 1_000_000_000_000,
    };
    const validator = new MovableRouteValidator(
      ctx.warpCore,
      ctx.chainMetadata,
      ctx.tokensByChainName,
      ctx.multiProvider as unknown as MultiProvider,
      testLogger,
    );
    const preparer = new MovableTransactionPreparer(
      ctx.warpCore,
      ctx.chainMetadata,
      ctx.tokensByChainName,
      validator,
      testLogger,
    );

    const { preparedTransactions, preparationFailureResults } =
      await preparer.prepareTransactions([
        buildInternalRoute({ amount: 1_000_000n }),
      ]);

    expect(preparationFailureResults).to.deep.equal([]);
    expect(preparedTransactions).to.have.lengthOf(1);
    expect(ctx.adapters.ethereum.getRebalanceQuotes.firstCall.args[3]).to.equal(
      1_000_000_000_000_000_000n,
    );
    expect(
      ctx.adapters.ethereum.populateRebalanceTx.firstCall.args[1],
    ).to.equal(1_000_000_000_000_000_000n);
  });

  it('records gas-estimation failures without sending transactions', async () => {
    const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
    ctx.multiProvider.estimateGas = Sinon.stub().rejects(
      new Error('Gas estimation failed'),
    );
    const actionTracker = createActionTrackerStub();
    const resultRecorder = new MovableResultRecorder(
      ctx.multiProvider as unknown as MultiProvider,
      actionTracker,
      testLogger,
    );
    const executor = new MovableChainTransactionExecutor(
      ctx.multiProvider as unknown as MultiProvider,
      resultRecorder,
      testLogger,
    );

    const results = await executor.executeTransactions([
      buildTestPreparedTransaction(),
    ]);

    expect(results).to.have.lengthOf(1);
    expect(results[0].success).to.be.false;
    expect(results[0].error).to.include('Gas estimation failed');
    expect((ctx.multiProvider.sendTransaction as Sinon.SinonStub).called).to.be
      .false;
  });

  it('records action attempt metrics for successful and failed sends', async () => {
    const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
    const actionTracker = createActionTrackerStub();
    const metrics = {
      recordActionAttempt: Sinon.stub(),
    };
    const resultRecorder = new MovableResultRecorder(
      ctx.multiProvider as unknown as MultiProvider,
      actionTracker,
      testLogger,
    );
    const executor = new MovableChainTransactionExecutor(
      ctx.multiProvider as unknown as MultiProvider,
      resultRecorder,
      testLogger,
      metrics as any,
    );
    const messageId = 'test-message-id-success';
    sandbox
      .stub(HyperlaneCore, 'getDispatchedMessages')
      .returns([{ id: messageId }] as ReturnType<
        typeof HyperlaneCore.getDispatchedMessages
      >);

    const failedTransaction = buildTestPreparedTransaction();
    const successfulTransaction = buildTestPreparedTransaction({
      route: buildInternalRoute({ intentId: 'intent-2' }),
    });
    (ctx.multiProvider.sendTransaction as Sinon.SinonStub)
      .onFirstCall()
      .rejects(new Error('Send failed'))
      .onSecondCall()
      .resolves({
        transactionHash: 'test-tx-hash-success',
      } as providers.TransactionReceipt);

    const results = await executor.executeTransactions([
      failedTransaction,
      successfulTransaction,
    ]);

    expect(results).to.have.lengthOf(2);
    expect(metrics.recordActionAttempt.calledTwice).to.be.true;
    expect(
      metrics.recordActionAttempt.firstCall.calledWithExactly(
        failedTransaction.route,
        false,
      ),
    ).to.be.true;
    expect(
      metrics.recordActionAttempt.secondCall.calledWithExactly(
        successfulTransaction.route,
        true,
      ),
    ).to.be.true;
  });

  it('builds successful receipt results and records rebalance actions', async () => {
    const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
    const actionTracker = createActionTrackerStub();
    const resultRecorder = new MovableResultRecorder(
      ctx.multiProvider as unknown as MultiProvider,
      actionTracker,
      testLogger,
    );
    const messageId = 'test-message-id-success';
    sandbox
      .stub(HyperlaneCore, 'getDispatchedMessages')
      .returns([{ id: messageId }] as ReturnType<
        typeof HyperlaneCore.getDispatchedMessages
      >);

    const result = resultRecorder.buildResult(buildTestPreparedTransaction(), {
      transactionHash: 'test-tx-hash-success',
    } as providers.TransactionReceipt);
    await resultRecorder.recordResults([result]);

    expect(result.success).to.be.true;
    expect(result.messageId).to.equal(messageId);
    expect((actionTracker.createRebalanceAction as Sinon.SinonStub).calledOnce)
      .to.be.true;
    expect(
      (actionTracker.createRebalanceAction as Sinon.SinonStub).firstCall
        .args[0],
    ).to.include({
      intentId: 'test-intent',
      messageId,
      type: 'rebalance_message',
    });
    expect((actionTracker.failRebalanceIntent as Sinon.SinonStub).called).to.be
      .false;
  });

  it('records route amount when successful results do not include canonical amount', async () => {
    const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
    const actionTracker = createActionTrackerStub();
    const resultRecorder = new MovableResultRecorder(
      ctx.multiProvider as unknown as MultiProvider,
      actionTracker,
      testLogger,
    );
    const route = buildInternalRoute({ amount: 123n });
    const result: MovableInternalExecutionResult = {
      route,
      intentId: route.intentId,
      success: true,
      messageId: 'test-message-id-success',
      txHash: 'test-tx-hash-success',
    };

    await resultRecorder.recordResults([result]);

    expect(
      (actionTracker.createRebalanceAction as Sinon.SinonStub).calledOnce,
    ).to.equal(true);
    expect(
      (actionTracker.createRebalanceAction as Sinon.SinonStub).firstCall
        .args[0],
    ).to.include({
      amount: 123n,
      intentId: route.intentId,
      messageId: 'test-message-id-success',
    });
    expect((actionTracker.failRebalanceIntent as Sinon.SinonStub).called).to.be
      .false;
  });

  it('fails intents when confirmed transactions do not dispatch messages', async () => {
    const ctx = createRebalancerTestContext(['ethereum', 'arbitrum']);
    const actionTracker = createActionTrackerStub();
    const resultRecorder = new MovableResultRecorder(
      ctx.multiProvider as unknown as MultiProvider,
      actionTracker,
      testLogger,
    );
    sandbox
      .stub(HyperlaneCore, 'getDispatchedMessages')
      .returns([] as ReturnType<typeof HyperlaneCore.getDispatchedMessages>);

    const result = resultRecorder.buildResult(buildTestPreparedTransaction(), {
      transactionHash: 'test-tx-hash-no-dispatch',
    } as providers.TransactionReceipt);
    await resultRecorder.recordResults([result]);

    expect(result.success).to.equal(false);
    expect(result.messageId).to.equal('');
    expect(result.error).to.include('no Dispatch event');
    expect((actionTracker.createRebalanceAction as Sinon.SinonStub).called).to
      .be.false;
    expect(
      (actionTracker.failRebalanceIntent as Sinon.SinonStub).calledOnceWith(
        'test-intent',
      ),
    ).to.equal(true);
  });
});
