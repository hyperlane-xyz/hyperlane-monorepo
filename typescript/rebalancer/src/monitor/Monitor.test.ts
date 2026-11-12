import { expect } from 'chai';
import { providers } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';

import {
  type ChainMap,
  type ChainMetadata,
  EvmHypSyntheticAdapter,
  EthJsonRpcBlockParameterTag,
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';
import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk/runtime';

import {
  type MonitorEvent,
  MonitorEventType,
  MonitorPollingError,
} from '../interfaces/IMonitor.js';

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
  const block = sinon.createStubInstance(TronJsonRpcProvider);
  block.send.resolves('0x64');
  block.getFinalizedBlockNumber.resolves(100);
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

  it('drains failed inventory reads before emitting the successful collateral snapshot', async () => {
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
    expect(handler.calledOnce).to.equal(true);
    expect(handler.firstCall.args[0].inventoryBalances).to.equal(undefined);
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
    expect(errors.firstCall.args[0].message).to.contain('block unavailable');
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

  it('reads Tron balances using explicit native finalized state', async () => {
    const { monitor, adapter, block, token } = setupTron('finalized');
    block.getFinalizedBlockNumber.resolves(96);
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
    expect(block.getFinalizedBlockNumber.called).to.equal(false);
    expect(block.getBlock.called).to.equal(false);
    expect(adapter.getBridgedSupply.calledOnce).to.equal(true);
    expect(adapter.getBridgedSupply.firstCall.args).to.deep.equal([
      { blockTag: EthJsonRpcBlockParameterTag.Finalized },
    ]);
    expect(event?.confirmedBlockTags.tron).to.equal(
      EthJsonRpcBlockParameterTag.Finalized,
    );
    expect(event?.tokensInfo).to.deep.equal([{ token, bridgedSupply: 5n }]);
  });

  it('retries an unavailable native finalized balance without falling back to latest', async () => {
    const { monitor, adapter, block } = setupTron(20);
    adapter.getBridgedSupply
      .onFirstCall()
      .rejects(new Error('solid state unavailable'));
    const errors = sinon.stub();
    let event: MonitorEvent | undefined;
    monitor.on(MonitorEventType.Error, errors);
    monitor.on(MonitorEventType.TokenInfo, (received) => {
      event = received;
      void monitor.stop();
    });
    await monitor.start();
    expect(errors.calledOnce).to.equal(true);
    expect(errors.firstCall.args[0].message).to.contain(
      'solid state unavailable',
    );
    expect(block.send.called).to.equal(false);
    expect(adapter.getBridgedSupply.calledTwice).to.equal(true);
    for (const call of adapter.getBridgedSupply.getCalls()) {
      expect(call.args).to.deep.equal([
        { blockTag: EthJsonRpcBlockParameterTag.Finalized },
      ]);
    }
    expect(event?.confirmedBlockTags.tron).to.equal(
      EthJsonRpcBlockParameterTag.Finalized,
    );
    expect(event?.tokensInfo[0].bridgedSupply).to.equal(5n);
  });

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
      if (received.inventoryBalances) void monitor.stop();
    });

    await monitor.start();
    expect(errors.calledOnce).to.equal(true);
    expect(errors.firstCall.args[0].message).to.contain(
      'inventory unavailable',
    );
    expect(handler.calledTwice).to.equal(true);
    expect(handler.firstCall.args[0].inventoryBalances).to.equal(undefined);
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

describe('Monitor inventory reads', () => {
  for (const failure of [
    'RPC timeout',
    'missing token',
    'missing signer',
    'collateral RPC timeout',
  ]) {
    it(`emits a polling error without a false zero balance on ${failure}`, async () => {
      const token = {
        chainName: 'solanamainnet',
        protocol: ProtocolType.Sealevel,
        isHypToken: () => true,
        getHypAdapter: () => ({
          getBridgedSupply: async () => {
            if (failure === 'collateral RPC timeout') throw new Error(failure);
            return 100n;
          },
        }),
        getAdapter: () => ({
          getBalance: async () => {
            throw new Error('RPC timeout');
          },
        }),
      };
      const warpCore = {
        tokens: failure === 'missing token' ? [] : [token],
        multiProvider: {
          getChainMetadata: () => ({ protocol: ProtocolType.Sealevel }),
        },
      } as unknown as WarpCore;
      const monitor = new Monitor(0, warpCore, pino({ level: 'silent' }), {
        chains: ['solanamainnet'],
        inventoryAddresses:
          failure === 'missing signer'
            ? {}
            : { [ProtocolType.Sealevel]: 'inventory-owner' },
      });
      const errors: Error[] = [];
      let balancesEmitted = 0;
      monitor.on(MonitorEventType.Error, (error) => {
        errors.push(error);
        void monitor.stop();
      });
      monitor.on(MonitorEventType.TokenInfo, (event) => {
        expect(event.inventoryBalances).to.equal(undefined);
        balancesEmitted++;
        void monitor.stop();
      });
      await monitor.start();
      expect(errors).to.have.length(1);
      expect(errors[0]).to.be.instanceOf(MonitorPollingError);
      expect(balancesEmitted).to.equal(
        failure === 'collateral RPC timeout' ? 0 : 1,
      );
    });
  }

  it('emits a genuine zero inventory balance normally', async () => {
    const token = {
      chainName: 'solanamainnet',
      protocol: ProtocolType.Sealevel,
      isHypToken: () => true,
      getHypAdapter: () => ({ getBridgedSupply: async () => 100n }),
      getAdapter: () => ({ getBalance: async () => 0n }),
    };
    const warpCore = {
      tokens: [token],
      multiProvider: {
        getChainMetadata: () => ({ protocol: ProtocolType.Sealevel }),
      },
    } as unknown as WarpCore;
    const monitor = new Monitor(0, warpCore, pino({ level: 'silent' }), {
      chains: ['solanamainnet'],
      inventoryAddresses: { [ProtocolType.Sealevel]: 'inventory-owner' },
    });
    const errors: Error[] = [];
    let inventory: Record<string, bigint> | undefined;
    monitor.on(MonitorEventType.Error, (error) => {
      errors.push(error);
      void monitor.stop();
    });
    monitor.on(MonitorEventType.TokenInfo, (event) => {
      inventory = event.inventoryBalances;
      void monitor.stop();
    });
    await monitor.start();
    expect(errors).to.have.length(0);
    expect(inventory).to.deep.equal({ solanamainnet: 0n });
  });
});
