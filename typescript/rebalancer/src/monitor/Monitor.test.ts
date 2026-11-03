import { expect } from 'chai';
import { providers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  type ChainMap,
  type ChainMetadata,
  EvmHypSyntheticAdapter,
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { type MonitorEvent, MonitorEventType } from '../interfaces/IMonitor.js';

import { Monitor } from './Monitor.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const logger = pino({ level: 'silent' });

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(count: number, withInventory = false) {
  const metadata: ChainMap<ChainMetadata> = {};
  const tokens = Array.from({ length: count }, (_, index) => {
    const chainName = `chain${index}`;
    metadata[chainName] = {
      name: chainName,
      protocol: ProtocolType.Ethereum,
      chainId: index + 1,
      domainId: index + 1,
      rpcUrls: [{ http: 'http://unused' }],
      blocks: { reorgPeriod: 2, confirmations: 1 },
    };
    return new Token({
      chainName,
      standard: TokenStandard.EvmHypSynthetic,
      addressOrDenom: ADDRESS,
      decimals: 18,
      name: 'Token',
      symbol: 'TOK',
    });
  });
  const multiProvider = new MultiProtocolProvider(metadata);
  const blocks = tokens.map(() =>
    sinon.createStubInstance(providers.JsonRpcProvider),
  );
  const adapters = tokens.map(() =>
    sinon.createStubInstance(EvmHypSyntheticAdapter),
  );
  const getProvider = sinon.stub(multiProvider, 'getEthersV5Provider');
  tokens.forEach((token, index) => {
    getProvider.withArgs(token.chainName).returns(blocks[index]);
    blocks[index].send.resolves('0x64');
    adapters[index].getBridgedSupply.resolves(BigInt(index));
    adapters[index].getBalance.resolves(BigInt(index + 10));
    sinon.stub(token, 'getHypAdapter').returns(adapters[index]);
    sinon.stub(token, 'getAdapter').returns(adapters[index]);
  });
  const monitor = new Monitor(
    0,
    new WarpCore(multiProvider, tokens),
    logger,
    withInventory
      ? {
          chains: tokens.map((token) => token.chainName),
          inventoryAddresses: { [ProtocolType.Ethereum]: ADDRESS },
        }
      : undefined,
  );
  return { monitor, tokens, blocks, adapters };
}

function setupTron(reorgPeriod: number | string) {
  const token = new Token({
    chainName: 'tron',
    standard: TokenStandard.TronHypSynthetic,
    addressOrDenom: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
    decimals: 6,
    name: 'Token',
    symbol: 'TOK',
  });
  const metadata: ChainMap<ChainMetadata> = {
    tron: {
      name: 'tron',
      protocol: ProtocolType.Tron,
      chainId: 728126428,
      domainId: 728126428,
      rpcUrls: [{ http: 'http://unused' }],
      blocks: { reorgPeriod, confirmations: 1 },
    },
  };
  const multiProvider = new MultiProtocolProvider(metadata);
  const block = sinon.createStubInstance(providers.JsonRpcProvider);
  block.send.resolves('0x64');
  sinon.stub(multiProvider, 'getEthersV5Provider').returns(block);
  const adapter = sinon.createStubInstance(EvmHypSyntheticAdapter);
  adapter.getBridgedSupply.resolves(5n);
  sinon.stub(token, 'getHypAdapter').returns(adapter);
  const monitor = new Monitor(0, new WarpCore(multiProvider, [token]), logger);
  return { monitor, adapter, block, token };
}

describe('Monitor concurrency', () => {
  afterEach(() => sinon.restore());

  it('bounds block and inventory reads, filling slots while another chain is slow', async () => {
    const { monitor, tokens, blocks, adapters } = setup(10, true);
    const blockGates = blocks.map(() => sinon.promise<string>());
    const inventoryGates = adapters.map(() => sinon.promise<bigint>());
    blocks.forEach((block, index) => block.send.returns(blockGates[index]));
    adapters.forEach((adapter, index) =>
      adapter.getBalance.returns(inventoryGates[index]),
    );
    let event: MonitorEvent | undefined;
    monitor.on(MonitorEventType.TokenInfo, (received) => {
      event = received;
      void monitor.stop();
    });

    const running = monitor.start();
    await nextTurn();
    expect(blocks.filter((block) => block.send.called).length).to.equal(8);
    expect(
      adapters.filter((adapter) => adapter.getBalance.called).length,
    ).to.equal(8);
    void blockGates[1].resolve('0x65');
    void inventoryGates[1].resolve(11n);
    await nextTurn();
    expect(blocks[8].send.calledOnce).to.equal(true);
    expect(adapters[8].getBalance.calledOnce).to.equal(true);
    expect(blocks[0].send.calledOnce).to.equal(true);
    expect(blocks[9].send.called).to.equal(false);
    expect(adapters[9].getBalance.called).to.equal(false);
    expect(
      adapters.every((adapter) => adapter.getBridgedSupply.notCalled),
    ).to.equal(true);

    blockGates.forEach((gate, index) => {
      if (index !== 1) void gate.resolve(`0x${(100 + index).toString(16)}`);
    });
    await nextTurn();
    expect(
      adapters.every((adapter) => adapter.getBridgedSupply.calledOnce),
    ).to.equal(true);
    expect(event).to.equal(undefined);
    inventoryGates.forEach((gate, index) => {
      if (index !== 1) void gate.resolve(BigInt(index + 10));
    });
    await running;
    expect(event?.tokensInfo.map(({ token }) => token)).to.deep.equal(tokens);
    expect(event?.confirmedBlockTags.chain1).to.equal(99);
    expect(event?.inventoryBalances?.chain9).to.equal(19n);
    adapters.forEach((adapter, index) => {
      expect(adapter.getBridgedSupply.firstCall.args).to.deep.equal([
        { blockTag: 98 + index },
      ]);
    });
  });

  it('bounds supply reads and preserves token order when reads complete out of order', async () => {
    const { monitor, tokens, adapters } = setup(10);
    const gates = adapters.map(() => sinon.promise<bigint>());
    adapters.forEach((adapter, index) =>
      adapter.getBridgedSupply.returns(gates[index]),
    );
    let event: MonitorEvent | undefined;
    monitor.on(MonitorEventType.TokenInfo, (received) => {
      event = received;
      void monitor.stop();
    });

    const running = monitor.start();
    await nextTurn();
    expect(
      adapters.filter((adapter) => adapter.getBridgedSupply.called).length,
    ).to.equal(8);
    void gates[1].resolve(1n);
    await nextTurn();
    expect(adapters[8].getBridgedSupply.calledOnce).to.equal(true);
    gates.forEach((gate, index) => {
      if (index !== 1) void gate.resolve(BigInt(index));
    });
    await running;
    expect(event?.tokensInfo).to.deep.equal(
      tokens.map((token, index) => ({ token, bridgedSupply: BigInt(index) })),
    );
  });

  it('drains reads after a supply failure before reporting the failed cycle', async () => {
    const { monitor, adapters } = setup(2, true);
    const supply = sinon.promise<bigint>();
    const inventory = sinon.promise<bigint>();
    adapters[0].getBridgedSupply.rejects(new Error('supply unavailable'));
    adapters[1].getBridgedSupply.returns(supply);
    adapters[0].getBalance.returns(inventory);
    const handler = sinon.stub();
    const errors = sinon.stub();
    monitor.on(MonitorEventType.TokenInfo, handler);
    monitor.on(MonitorEventType.Error, (error) => {
      errors(error);
      void monitor.stop();
    });

    const running = monitor.start();
    await nextTurn();
    expect(errors.notCalled).to.equal(true);
    void supply.resolve(1n);
    await nextTurn();
    expect(errors.notCalled).to.equal(true);
    void inventory.resolve(2n);
    await running;
    expect(errors.calledOnce).to.equal(true);
    expect(handler.notCalled).to.equal(true);
    expect(adapters[0].getBridgedSupply.calledOnce).to.equal(true);
    expect(adapters[0].getBridgedSupply.firstCall.args).to.deep.equal([
      { blockTag: 98 },
    ]);
  });

  it('drains supply and inventory reads after an inventory failure without emitting balances', async () => {
    const { monitor, adapters } = setup(2, true);
    const supply = sinon.promise<bigint>();
    const inventory = sinon.promise<bigint>();
    adapters[0].getBalance.rejects(new Error('inventory unavailable'));
    adapters[1].getBalance.returns(inventory);
    adapters[0].getBridgedSupply.returns(supply);
    const handler = sinon.stub();
    const errors = sinon.stub();
    monitor.on(MonitorEventType.TokenInfo, handler);
    monitor.on(MonitorEventType.Error, (error) => {
      errors(error);
      void monitor.stop();
    });

    const running = monitor.start();
    await nextTurn();
    expect(errors.notCalled).to.equal(true);
    void inventory.resolve(11n);
    await nextTurn();
    expect(errors.notCalled).to.equal(true);
    void supply.resolve(0n);
    await running;
    expect(errors.calledOnce).to.equal(true);
    expect(errors.firstCall.args[0].message).to.contain(
      'inventory unavailable',
    );
    expect(handler.notCalled).to.equal(true);
  });

  it('retries a failed confirmed block lookup without emitting latest-state supply', async () => {
    const { monitor, blocks, adapters } = setup(1, true);
    blocks[0].send.onFirstCall().rejects(new Error('block unavailable'));
    const errors = sinon.stub();
    let event: MonitorEvent | undefined;
    let supplyReadOnError = false;
    monitor.on(MonitorEventType.Error, (error) => {
      errors(error);
      supplyReadOnError = adapters[0].getBridgedSupply.called;
    });
    monitor.on(MonitorEventType.TokenInfo, (received) => {
      event = received;
      void monitor.stop();
    });

    await monitor.start();
    expect(errors.calledOnce).to.equal(true);
    expect(errors.firstCall.args[0].message).to.contain(
      'Confirmed block unavailable for chain0',
    );
    expect(supplyReadOnError).to.equal(false);
    expect(blocks[0].send.calledTwice).to.equal(true);
    expect(adapters[0].getBridgedSupply.calledOnce).to.equal(true);
    expect(adapters[0].getBridgedSupply.firstCall.args).to.deep.equal([
      { blockTag: 98 },
    ]);
    expect(event?.confirmedBlockTags.chain0).to.equal(98);
    expect(event?.tokensInfo[0].bridgedSupply).to.equal(0n);
    expect(event?.inventoryBalances).to.deep.equal({ chain0: 10n });
  });

  it('preserves optional block tags for Tron named reorg periods', async () => {
    const { monitor, adapter, block, token } = setupTron('finalized');
    const errors = sinon.stub();
    let event: MonitorEvent | undefined;
    monitor.on(MonitorEventType.Error, (error) => {
      errors(error);
      void monitor.stop();
    });
    monitor.on(MonitorEventType.TokenInfo, (received) => {
      event = received;
      void monitor.stop();
    });

    await monitor.start();
    expect(errors.notCalled).to.equal(true);
    expect(block.send.notCalled).to.equal(true);
    expect(adapter.getBridgedSupply.calledOnce).to.equal(true);
    expect(adapter.getBridgedSupply.firstCall.args).to.deep.equal([
      { blockTag: undefined },
    ]);
    expect(event?.confirmedBlockTags.tron).to.equal(undefined);
    expect(event?.tokensInfo).to.deep.equal([{ token, bridgedSupply: 5n }]);
  });

  for (const failWithRpcError of [true, false]) {
    it(`retries a numeric Tron block ${failWithRpcError ? 'RPC failure' : 'invalid response'} before emitting supply`, async () => {
      const { monitor, adapter, block } = setupTron(20);
      if (failWithRpcError) {
        block.send.onFirstCall().rejects(new Error('block unavailable'));
      } else {
        block.send.onFirstCall().resolves(undefined);
      }
      const errors = sinon.stub();
      let supplyReadOnError = false;
      let event: MonitorEvent | undefined;
      monitor.on(MonitorEventType.Error, (error) => {
        errors(error);
        supplyReadOnError = adapter.getBridgedSupply.called;
      });
      monitor.on(MonitorEventType.TokenInfo, (received) => {
        event = received;
        void monitor.stop();
      });

      await monitor.start();
      expect(errors.calledOnce).to.equal(true);
      expect(errors.firstCall.args[0].message).to.contain(
        failWithRpcError
          ? 'block unavailable'
          : 'Invalid eth_blockNumber response',
      );
      expect(supplyReadOnError).to.equal(false);
      expect(block.send.calledTwice).to.equal(true);
      expect(adapter.getBridgedSupply.calledOnce).to.equal(true);
      expect(adapter.getBridgedSupply.firstCall.args).to.deep.equal([
        { blockTag: 80 },
      ]);
      expect(event?.confirmedBlockTags.tron).to.equal(80);
      expect(event?.tokensInfo[0].bridgedSupply).to.equal(5n);
    });
  }

  it('emits inventory balances from a later cycle after an inventory failure', async () => {
    const { monitor, adapters } = setup(1, true);
    adapters[0].getBalance
      .onFirstCall()
      .rejects(new Error('inventory unavailable'));
    const errors = sinon.stub();
    const handler = sinon.stub();
    let event: MonitorEvent | undefined;
    monitor.on(MonitorEventType.Error, errors);
    monitor.on(MonitorEventType.TokenInfo, (received) => {
      handler(received);
      event = received;
      void monitor.stop();
    });

    await monitor.start();
    expect(errors.calledOnce).to.equal(true);
    expect(errors.firstCall.args[0].message).to.contain(
      'inventory unavailable',
    );
    expect(handler.calledOnce).to.equal(true);
    sinon.assert.callOrder(errors, handler);
    expect(adapters[0].getBalance.calledTwice).to.equal(true);
    expect(event?.inventoryBalances).to.deep.equal({ chain0: 10n });
  });

  it('emits successfully read zero inventory balances', async () => {
    const { monitor, adapters } = setup(1, true);
    adapters[0].getBalance.resolves(0n);
    let event: MonitorEvent | undefined;
    monitor.on(MonitorEventType.TokenInfo, (received) => {
      event = received;
      void monitor.stop();
    });
    await monitor.start();
    expect(event?.inventoryBalances).to.deep.equal({ chain0: 0n });
  });

  it('awaits its consumer before another polling cycle and before stop completes', async () => {
    const { monitor, adapters } = setup(1);
    const consumer = sinon.promise<void>();
    const handler = sinon.stub().returns(consumer);
    monitor.on(MonitorEventType.TokenInfo, handler);
    const running = monitor.start();
    await nextTurn();
    expect(handler.calledOnce).to.equal(true);
    expect(adapters[0].getBridgedSupply.calledOnce).to.equal(true);

    let stopped = false;
    const stop = monitor.stop().then(() => {
      stopped = true;
    });
    await nextTurn();
    expect(stopped).to.equal(false);
    expect(adapters[0].getBridgedSupply.calledOnce).to.equal(true);
    void consumer.resolve(undefined);
    await Promise.all([running, stop]);
    expect(stopped).to.equal(true);
  });
});
