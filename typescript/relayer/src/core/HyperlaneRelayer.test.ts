import { expect } from 'chai';
import { providers } from 'ethers';
import sinon from 'sinon';

import {
  HyperlaneCore,
  EvmHookReader,
  HookType,
  type DerivedHookConfig,
  MultiProvider,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { formatMessage } from '@hyperlane-xyz/utils';

import { testTransactionReceipt } from '../metadata/testUtils.js';

import { HyperlaneRelayer } from './HyperlaneRelayer.js';
import { RelayerCache } from './cache.js';

class BacklogRelayer extends HyperlaneRelayer {
  drain(): Promise<void> {
    this.stopRelayingHandler = () => {};
    this.relayGeneration++;
    return this.flushBacklog();
  }
}

describe('HyperlaneRelayer backlog scheduling', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;
  let relayer: BacklogRelayer;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers({ now: 10_000 });
    // Bound synchronous clock reads so a regression fails instead of hanging
    // the test process in the original queue-rotation loop.
    let clockReads = 0;
    sandbox.stub(Date, 'now').callsFake(() => {
      if (++clockReads > 1000) throw new Error('Backlog failed to yield');
      return clock.now;
    });
    multiProvider = MultiProvider.createTestMultiProvider();
    const core = new HyperlaneCore({}, multiProvider);
    relayer = new BacklogRelayer({ core, retryTimeout: 5000 });
    const provider = sandbox.createStubInstance(providers.JsonRpcProvider);
    multiProvider.setProvider(TestChainName.test1, provider);
    provider.getTransactionReceipt.resolves(testTransactionReceipt());
  });

  afterEach(() => sandbox.restore());

  function message(
    nonce: number,
    attempts = 1,
  ): RelayerCache['backlog'][number] {
    return {
      attempts,
      lastAttempt: clock.now,
      message: formatMessage(
        0,
        nonce,
        multiProvider.getDomainId(TestChainName.test1),
        '0x1111111111111111111111111111111111111111',
        multiProvider.getDomainId(TestChainName.test2),
        '0x2222222222222222222222222222222222222222',
        '0x',
      ),
      dispatchTx: testTransactionReceipt().transactionHash,
    };
  }

  it('yields while every message is in backoff and permits stopping', async () => {
    relayer.backlog = [message(0)];
    const relay = sandbox.stub(relayer, 'relayMessage');
    const draining = relayer.drain();
    await clock.tickAsync(0);
    expect(relay.called).to.be.false;
    expect(clock.countTimers()).to.equal(1);

    relayer.stop();
    await clock.tickAsync(1000);
    await draining;
    expect(relay.called).to.be.false;
    expect(relayer.backlog).to.have.length(1);
    expect(clock.countTimers()).to.equal(0);
  });

  it('processes eligible messages behind a delayed head in queue order', async () => {
    const delayed = message(0);
    const first = message(1, 0);
    const second = message(2, 0);
    relayer.backlog = [delayed, first, second];
    const relay = sandbox
      .stub(relayer, 'relayMessage')
      .resolves(testTransactionReceipt());
    const draining = relayer.drain();
    await clock.tickAsync(0);

    expect(relay.callCount).to.equal(2);
    expect(relay.firstCall.args[2]?.message).to.equal(first.message);
    expect(relay.secondCall.args[2]?.message).to.equal(second.message);
    expect(relayer.backlog).to.deep.equal([delayed]);

    relayer.stop();
    await clock.tickAsync(1000);
    await draining;
  });

  it('retains a failed message and waits until its new retry deadline', async () => {
    const queued = message(0, 0);
    relayer.backlog = [queued];
    const relay = sandbox
      .stub(relayer, 'relayMessage')
      .onFirstCall()
      .rejects(new Error('RPC unavailable'))
      .onSecondCall()
      .resolves(testTransactionReceipt());
    const draining = relayer.drain();
    await clock.tickAsync(0);
    expect(relayer.backlog).to.deep.equal([{ ...queued, attempts: 1 }]);

    await clock.tickAsync(4999);
    expect(relay.callCount).to.equal(1);
    await clock.tickAsync(1);
    expect(relay.callCount).to.equal(2);
    expect(relayer.backlog).to.have.length(0);

    relayer.stop();
    await clock.tickAsync(1000);
    await draining;
  });
  it('retires the previous sleeping consumer when relaying restarts', async () => {
    const relay = sandbox.stub(relayer, 'relayMessage');
    const oldRun = relayer.drain();
    relayer.stop();
    const newRun = relayer.drain();
    await clock.tickAsync(1000);
    await oldRun;
    expect(clock.countTimers()).to.equal(1);
    expect(relay.called).to.be.false;

    relayer.stop();
    await clock.tickAsync(1000);
    await newRun;
    expect(clock.countTimers()).to.equal(0);
  });
  it('wakes at the earliest retry deadline below the idle polling interval', async () => {
    const later = { ...message(0), lastAttempt: 5900 };
    const earlier = { ...message(1), lastAttempt: 5500 };
    relayer.backlog = [later, earlier];
    const relay = sandbox
      .stub(relayer, 'relayMessage')
      .resolves(testTransactionReceipt());
    const draining = relayer.drain();
    await clock.tickAsync(499);
    expect(relay.called).to.be.false;
    await clock.tickAsync(1);
    expect(relay.callCount).to.equal(1);
    expect(relay.firstCall.args[2]?.message).to.equal(earlier.message);
    relayer.stop();
    await clock.tickAsync(400);
    await draining;
  });

  it('returns a fetched message to the queue when stopped before delivery', async () => {
    const queued = message(0, 0);
    relayer.backlog = [queued];
    let resolveReceipt: (
      receipt: ReturnType<typeof testTransactionReceipt>,
    ) => void = () => {
      throw new Error('Receipt request not started');
    };
    const provider = sandbox.createStubInstance(providers.JsonRpcProvider);
    provider.getTransactionReceipt.returns(
      new Promise((resolve) => {
        resolveReceipt = resolve;
      }),
    );
    multiProvider.setProvider(TestChainName.test1, provider);
    const relay = sandbox.stub(relayer, 'relayMessage');
    const draining = relayer.drain();
    relayer.stop();
    resolveReceipt(testTransactionReceipt());
    await draining;
    expect(relay.called).to.be.false;
    expect(relayer.backlog).to.deep.equal([queued]);
  });

  it('requeues a delivery failure that settles after stopping', async () => {
    const queued = message(0, 0);
    relayer.backlog = [queued];
    let rejectDelivery: (error: Error) => void = () => {
      throw new Error('Delivery not started');
    };
    sandbox.stub(relayer, 'relayMessage').returns(
      new Promise((_, reject) => {
        rejectDelivery = reject;
      }),
    );
    const draining = relayer.drain();
    await clock.tickAsync(0);
    relayer.stop();
    rejectDelivery(new Error('Delivery failed after stop'));
    await draining;
    expect(relayer.backlog).to.deep.equal([{ ...queued, attempts: 1 }]);
  });

  it('preserves uncached pending work across public stop/start and retires the old worker', async () => {
    const core = new HyperlaneCore({}, multiProvider);
    const removeHandler = sandbox.stub();
    sandbox.stub(core, 'onDispatch').returns({ removeHandler });
    const publicRelayer = new HyperlaneRelayer({
      core,
      caching: false,
      retryTimeout: 5000,
    });
    const queued = message(0);
    publicRelayer.backlog = [queued];
    const relay = sandbox
      .stub(publicRelayer, 'relayMessage')
      .resolves(testTransactionReceipt());

    publicRelayer.start();
    publicRelayer.stop();
    publicRelayer.start();
    await clock.tickAsync(1000);
    expect(publicRelayer.backlog).to.deep.equal([queued]);
    expect(clock.countTimers()).to.equal(1);

    await clock.tickAsync(4000);
    expect(relay.calledOnce).to.be.true;
    expect(publicRelayer.backlog).to.have.length(0);
    publicRelayer.stop();
    await clock.tickAsync(1000);
    expect(removeHandler.calledTwice).to.be.true;
    expect(clock.countTimers()).to.equal(0);
  });
  it('serializes a restarted worker behind the previous in-flight delivery', async () => {
    const core = new HyperlaneCore({}, multiProvider);
    sandbox.stub(core, 'onDispatch').returns({ removeHandler: () => {} });
    const active = new HyperlaneRelayer({ core, caching: false });
    active.backlog = [message(0, 0), message(1, 0)];
    let finishFirst: (
      receipt: ReturnType<typeof testTransactionReceipt>,
    ) => void = () => {
      throw new Error('First delivery not started');
    };
    const relay = sandbox.stub(active, 'relayMessage');
    relay.onFirstCall().returns(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    relay.onSecondCall().resolves(testTransactionReceipt());
    active.start();
    await clock.tickAsync(0);
    active.stop();
    active.start();
    await clock.tickAsync(1000);
    expect(relay.callCount).to.equal(1);
    finishFirst(testTransactionReceipt());
    await clock.tickAsync(0);
    expect(relay.callCount).to.equal(2);
    const stopped = active.stopAndDrain();
    await clock.tickAsync(1000);
    await stopped;
    expect(active.backlog).to.have.length(0);
    expect(clock.countTimers()).to.equal(0);
  });

  it('isolates message-scoped hook derivations from other destinations and the generic cache', async () => {
    const address = '0x3333333333333333333333333333333333333333';
    const destinations: number[][] = [];
    const derive = sandbox
      .stub(EvmHookReader.prototype, 'deriveHookConfig')
      .callsFake(
        async function (this: EvmHookReader): Promise<DerivedHookConfig> {
          destinations.push(this.possibleDomainIds());
          return { address, type: HookType.MERKLE_TREE };
        },
      );
    const first = HyperlaneCore.parseDispatchedMessage(message(0).message);
    const secondRaw = formatMessage(
      0,
      1,
      first.parsed.origin,
      first.parsed.sender,
      multiProvider.getDomainId(TestChainName.test3),
      first.parsed.recipient,
      '0x',
    );
    const second = HyperlaneCore.parseDispatchedMessage(secondRaw);
    await relayer.getHookConfig(TestChainName.test1, address, first);
    await relayer.getHookConfig(TestChainName.test1, address, second);
    await relayer.getHookConfig(TestChainName.test1, address);
    await relayer.getHookConfig(TestChainName.test1, address, first);
    expect(derive.callCount).to.equal(3);
    expect(destinations[0]).to.deep.equal([first.parsed.destination]);
    expect(destinations[1]).to.deep.equal([second.parsed.destination]);
    expect(destinations[2])
      .to.include(first.parsed.destination)
      .and.include(second.parsed.destination);
  });

  it('keeps a rejected delivery retry queued when its observer throws', async () => {
    const core = new HyperlaneCore({}, multiProvider);
    sandbox.stub(core, 'onDispatch').returns({ removeHandler: () => {} });
    const active = new HyperlaneRelayer({
      core,
      caching: false,
      observer: {
        onEvent: () => {
          throw new Error('Metrics failed');
        },
      },
    });
    const queued = message(0, 0);
    active.backlog = [queued];
    sandbox.stub(active, 'relayMessage').rejects(new Error('RPC failed'));
    sandbox.stub(active.logger, 'error');
    active.start();
    await clock.tickAsync(0);
    const stopped = active.stopAndDrain();
    await clock.tickAsync(1000);
    await stopped;
    expect(active.backlog).to.deep.equal([{ ...queued, attempts: 1 }]);
  });

  it('does not turn an already-delivered result into a failure when its observer throws', async () => {
    const core = new HyperlaneCore({}, multiProvider);
    sandbox.stub(core, 'isDelivered').resolves(true);
    sandbox
      .stub(core, 'getProcessedReceipt')
      .resolves(testTransactionReceipt());
    const active = new HyperlaneRelayer({
      core,
      observer: {
        onEvent: () => {
          throw new Error('Metrics failed');
        },
      },
    });
    sandbox.stub(active.logger, 'error');
    const dispatched = HyperlaneCore.parseDispatchedMessage(message(0).message);
    expect(
      await active.relayMessage(testTransactionReceipt(), 0, dispatched),
    ).to.deep.equal(testTransactionReceipt());
  });
  it('retains malformed persisted input when the worker fails and permits a repaired restart', async () => {
    const core = new HyperlaneCore({}, multiProvider);
    sandbox.stub(core, 'onDispatch').returns({ removeHandler: () => {} });
    const active = new HyperlaneRelayer({ core, caching: false });
    const malformed = { ...message(0, 0), message: 'invalid hex' };
    active.backlog = [malformed];
    sandbox.stub(active.logger, 'error');
    active.start();
    await clock.tickAsync(0);
    const [outcome] = await Promise.allSettled([active.stopAndDrain()]);
    expect(outcome.status).to.equal('rejected');
    expect(active.backlog).to.deep.equal([malformed]);
    active.backlog = [message(1, 0)];
    const relay = sandbox
      .stub(active, 'relayMessage')
      .resolves(testTransactionReceipt());
    active.start();
    await clock.tickAsync(0);
    expect(relay.calledOnce).to.be.true;
    const stopped = active.stopAndDrain();
    await clock.tickAsync(1000);
    await stopped;
  });
});
