import { expect } from 'chai';
import sinon from 'sinon';

import {
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { ExplorerPendingTransfersClient } from './explorer.js';
import {
  metricsRegister,
  resetInventoryBalanceMetrics,
  resetPendingDestinationMetrics,
} from './metrics.js';
import {
  collectCoinGeckoIds,
  runRouteCycle,
  type RouteRuntime,
  type SharedMonitorContext,
} from './monitor.js';
import { getLogger } from './utils.js';

function fixture() {
  const provider = new MultiProtocolProvider<{ mailbox?: string }>({
    ethereum: {
      name: 'ethereum',
      chainId: 1,
      domainId: 1,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'http://localhost:8545' }],
    },
  });
  const tokens = [
    TokenStandard.EvmHypCollateral,
    TokenStandard.EvmHypSynthetic,
  ].map(
    (standard, index) =>
      new Token({
        chainName: 'ethereum',
        standard,
        addressOrDenom: `0x${String(index + 1).padStart(40, '0')}`,
        decimals: 0,
        symbol: `TOKEN${index}`,
        name: `Token ${index}`,
        coinGeckoId: `price-${index}`,
      }),
  );
  const supplyReads = tokens.map((token) => {
    const adapter = token.getHypAdapter(provider);
    sinon.stub(token, 'getHypAdapter').returns(adapter);
    return sinon.stub(adapter, 'getBridgedSupply').resolves(3n);
  });
  const inventoryReads = tokens.map((token) => {
    const adapter = token.getAdapter(provider);
    sinon.stub(token, 'getAdapter').returns(adapter);
    return sinon.stub(adapter, 'getBalance').resolves(7n);
  });
  const routerNodes = tokens.map((token) => ({
    nodeId: `${token.symbol}|${token.chainName}|${token.addressOrDenom}`,
    chainName: token.chainName,
    domainId: 1,
    routerAddress: token.addressOrDenom,
    tokenAddress: token.addressOrDenom,
    tokenName: token.name,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    token,
  }));
  const pendingTransfersClient = new ExplorerPendingTransfersClient(
    'http://localhost:8080',
    routerNodes,
    getLogger(),
  );
  const pendingReads = sinon
    .stub(pendingTransfersClient, 'getPendingDestinationTransfers')
    .resolves(
      routerNodes.map((node) => ({
        messageId: `message-${node.nodeId}`,
        originDomainId: 1,
        destinationDomainId: 1,
        destinationChain: node.chainName,
        destinationNodeId: node.nodeId,
        destinationRouter: node.routerAddress,
        amountBaseUnits: 5n,
      })),
    );
  const priceRead = sinon.stub().resolves(2);
  const ctx: SharedMonitorContext = {
    multiProtocolProvider: provider,
    chainMetadata: provider.metadata,
    priceGetter: { tryGetTokenPrice: priceRead },
    prefetchPrices: async () => {},
  };
  const route: RouteRuntime = {
    warpRouteId: 'TEST/efficiency',
    warpCore: new WarpCore(provider, tokens),
    warpDeployConfig: null,
    routerNodes,
    pendingTransfersClient,
    explorerQueryLimit: 200,
    inventoryAddress: '0x0000000000000000000000000000000000000009',
    skipSharedBalanceMetrics: false,
  };
  return { ctx, route, supplyReads, inventoryReads, pendingReads, priceRead };
}

async function monitorOnlyMetrics() {
  return (await metricsRegister.metrics())
    .split('\n')
    .filter((line) =>
      /^hyperlane_warp_route_(pending_destination_|projected_deficit|inventory_balance)/.test(
        line,
      ),
    )
    .sort();
}

describe('delegated shared balance collection', () => {
  beforeEach(() => {
    resetInventoryBalanceMetrics();
    resetPendingDestinationMetrics();
  });
  afterEach(() => {
    sinon.restore();
    resetInventoryBalanceMetrics();
    resetPendingDestinationMetrics();
  });

  it('skips synthetic supply but preserves monitor-only metrics and fresh reads', async () => {
    const { ctx, route, supplyReads, inventoryReads, pendingReads, priceRead } =
      fixture();
    await runRouteCycle(ctx, route);
    expect(supplyReads.map((read) => read.callCount)).to.deep.equal([1, 1]);
    const expected = await monitorOnlyMetrics();
    expect(expected).to.have.length(9); // Six pending, one deficit, two inventory.
    expect(
      expected.some(
        (line) =>
          line.startsWith('hyperlane_warp_route_projected_deficit{') &&
          line.endsWith(' 2'),
      ),
    ).to.equal(true);
    route.skipSharedBalanceMetrics = true;
    for (let cycle = 0; cycle < 5; cycle++) {
      await runRouteCycle(ctx, route);
      expect(await monitorOnlyMetrics()).to.deep.equal(expected);
    }
    expect(supplyReads.map((read) => read.callCount)).to.deep.equal([6, 1]);
    expect(inventoryReads.map((read) => read.callCount)).to.deep.equal([6, 6]);
    expect(pendingReads.callCount).to.equal(6);
    expect(priceRead.callCount).to.equal(1);
    supplyReads[0].resolves(1n);
    inventoryReads[1].resolves(9n);
    await runRouteCycle(ctx, route);
    const changed = await monitorOnlyMetrics();
    expect(
      changed.some(
        (line) =>
          line.startsWith('hyperlane_warp_route_projected_deficit{') &&
          line.endsWith(' 4'),
      ),
    ).to.equal(true);
    expect(
      changed.some(
        (line) =>
          line.startsWith('hyperlane_warp_route_inventory_balance{') &&
          line.includes('token_symbol="TOKEN1"') &&
          line.endsWith(' 9'),
      ),
    ).to.equal(true);
  });

  it('prefetches prices only for routes that emit USD metrics, retaining shared IDs', () => {
    const { route } = fixture();
    const delegated = { ...route, skipSharedBalanceMetrics: true };
    expect(collectCoinGeckoIds([delegated])).to.deep.equal([]);
    expect(collectCoinGeckoIds([delegated, route])).to.deep.equal([
      'price-0',
      'price-1',
    ]);
    expect(collectCoinGeckoIds([route, delegated, route])).to.deep.equal([
      'price-0',
      'price-1',
    ]);
  });
});
