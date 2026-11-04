import { expect } from 'chai';
import { providers } from 'ethers';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import sinon from 'sinon';

import { PartialRegistry } from '@hyperlane-xyz/registry';
import {
  HyperlaneCore,
  MultiProvider,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { formatMessage } from '@hyperlane-xyz/utils';

import { testTransactionReceipt } from '../metadata/testUtils.js';

import { RelayerService } from './RelayerService.js';

describe('RelayerService lifecycle ownership', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;
  let directory: string;
  let service: RelayerService;
  let multiProvider: MultiProvider;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers({ now: 10_000 });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relayer-lifecycle-'));
    multiProvider = MultiProvider.createTestMultiProvider();
    const provider = sandbox.createStubInstance(providers.JsonRpcProvider);
    provider.getTransactionReceipt.resolves(testTransactionReceipt());
    multiProvider.setProvider(TestChainName.test1, provider);
    const core = new HyperlaneCore({}, multiProvider);
    sandbox.stub(HyperlaneCore, 'fromAddressesMap').returns(core);
    sandbox.stub(core, 'onDispatch').returns({ removeHandler: () => {} });
    service = await RelayerService.create(
      multiProvider,
      new PartialRegistry({}),
      {
        enableMetrics: false,
        relayerConfig: { cacheFile: path.join(directory, 'cache.json') },
      },
    );
  });

  afterEach(async () => {
    const stopped = service.stop();
    await clock.tickAsync(1000);
    await stopped;
    sandbox.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('serializes repeated start/stop and owns exactly one pair of signal handlers', async () => {
    const initialInt = process.listenerCount('SIGINT');
    const initialTerm = process.listenerCount('SIGTERM');
    await service.stop();
    await Promise.all([service.start(), service.start()]);
    expect(process.listenerCount('SIGINT')).to.equal(initialInt + 1);
    expect(process.listenerCount('SIGTERM')).to.equal(initialTerm + 1);
    const stopping = Promise.all([service.stop(), service.stop()]);
    await clock.tickAsync(1000);
    await stopping;
    expect(process.listenerCount('SIGINT')).to.equal(initialInt);
    expect(process.listenerCount('SIGTERM')).to.equal(initialTerm);

    await service.start();
    expect(process.listenerCount('SIGINT')).to.equal(initialInt + 1);
    const stopped = service.stop();
    await clock.tickAsync(1000);
    await stopped;
    expect(process.listenerCount('SIGINT')).to.equal(initialInt);
    expect(process.listenerCount('SIGTERM')).to.equal(initialTerm);
    expect(clock.countTimers()).to.equal(0);
  });

  it('persists an in-flight failure only after it has returned to the backlog', async () => {
    const relayer = await service.getRelayer();
    const rawMessage = formatMessage(
      0,
      0,
      multiProvider.getDomainId(TestChainName.test1),
      '0x1111111111111111111111111111111111111111',
      multiProvider.getDomainId(TestChainName.test2),
      '0x2222222222222222222222222222222222222222',
      '0x',
    );
    relayer.cache?.backlog.push({
      attempts: 0,
      lastAttempt: 10_000,
      message: rawMessage,
      dispatchTx: testTransactionReceipt().transactionHash,
    });
    let rejectDelivery: (error: Error) => void = () => {
      throw new Error('Delivery not started');
    };
    sandbox.stub(relayer, 'relayMessage').returns(
      new Promise((_, reject) => {
        rejectDelivery = reject;
      }),
    );
    await service.start();
    await clock.tickAsync(0);
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await clock.tickAsync(0);
    expect(stopped).to.be.false;
    const cacheFile = path.join(directory, 'cache.json');
    expect(fs.existsSync(cacheFile)).to.be.false;
    rejectDelivery(new Error('RPC failed after shutdown began'));
    await stopping;
    expect(stopped).to.be.true;
    const saved: unknown = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(saved).to.deep.equal(relayer.cache);
    expect(relayer.cache?.backlog).to.have.length(1);
    expect(relayer.cache?.backlog[0].attempts).to.equal(1);
    expect(fs.readdirSync(directory)).to.deep.equal(['cache.json']);
  });

  it('removes both signal handlers when either signal initiates shutdown', async () => {
    const initial = process.listeners('SIGINT');
    const initialTerm = process.listenerCount('SIGTERM');
    await service.start();
    const handler = process
      .listeners('SIGINT')
      .find((listener) => !initial.includes(listener));
    if (!handler) throw new Error('Signal handler missing');
    handler('SIGINT');
    await clock.tickAsync(1000);
    await service.stop();
    expect(process.listeners('SIGINT')).to.deep.equal(initial);
    expect(process.listenerCount('SIGTERM')).to.equal(initialTerm);
    expect(clock.countTimers()).to.equal(0);
  });
  it('waits for its metrics server to close before stop resolves', async () => {
    const server = sandbox.createStubInstance(http.Server);
    server.on.returns(server);
    server.listen.returns(server);
    let finishClose: () => void = () => {
      throw new Error('Close not started');
    };
    server.close.callsFake((callback) => {
      finishClose = () => callback?.();
      return server;
    });
    sandbox.stub(http, 'createServer').returns(server);
    const monitored = await RelayerService.create(
      multiProvider,
      new PartialRegistry({}),
      { enableMetrics: true },
    );
    await monitored.start();
    let stopped = false;
    const stopping = monitored.stop().then(() => {
      stopped = true;
    });
    await clock.tickAsync(1000);
    expect(stopped).to.be.false;
    expect(server.close.calledOnce).to.be.true;
    finishClose();
    await stopping;
    expect(stopped).to.be.true;
  });

  it('preserves the prior snapshot on persistence failure and permits a stop retry', async () => {
    const cacheFile = path.join(directory, 'cache.json');
    fs.writeFileSync(cacheFile, 'prior snapshot');
    const failure = new Error('Atomic rename failed');
    const rename = fs.renameSync;
    const persist = sandbox.stub(fs, 'renameSync').callsFake(rename);
    persist.onFirstCall().throws(failure);
    await service.start();
    const stopping = Promise.allSettled([service.stop()]);
    await clock.tickAsync(1000);
    const [outcome] = await stopping;
    expect(outcome.status).to.equal('rejected');
    if (outcome.status === 'rejected') expect(outcome.reason).to.equal(failure);
    expect(fs.readFileSync(cacheFile, 'utf8')).to.equal('prior snapshot');
    await service.stop();
    expect(persist.calledTwice).to.be.true;
    const saved: unknown = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(saved).to.deep.equal(service.getCache());
  });
});
