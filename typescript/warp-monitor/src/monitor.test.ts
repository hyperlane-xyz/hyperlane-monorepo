import { expect } from 'chai';

import type { Token, WarpCore } from '@hyperlane-xyz/sdk';
import type {
  PendingDestinationTransfer,
  RouterNodeMetadata,
  ExplorerPendingTransfersClient,
} from './explorer.js';

import {
  resetInventoryBalanceMetrics,
  resetPendingDestinationMetrics,
  metricsRegister,
} from './metrics.js';
import { updatePendingAndInventoryMetrics } from './monitor.js';

function createMockToken({
  collateralized,
  decimals,
  getBalance = async () => 0n,
}: {
  collateralized: boolean;
  decimals: number;
  getBalance?: () => Promise<bigint>;
}): Token {
  return {
    isCollateralized: () => collateralized,
    amount: ((amount: bigint) => ({
      getDecimalFormattedAmount: () => Number(amount) / 10 ** decimals,
    })) as Token['amount'],
    getAdapter: (() => ({
      getBalance,
    })) as unknown as Token['getAdapter'],
  } as Token;
}

describe('updatePendingAndInventoryMetrics', () => {
  afterEach(() => {
    resetPendingDestinationMetrics();
    resetInventoryBalanceMetrics();
  });

  it('emits projected deficit metrics only for collateralized nodes', async () => {
    const collateralizedNodeId = 'COLLAT|anvil2|0xroutera';
    const nonCollateralizedNodeId = 'SYNTH|anvil2|0xrouterb';
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId: collateralizedNodeId,
        chainName: 'anvil2',
        domainId: 31337,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'Collateral Token',
        tokenSymbol: 'COLLAT',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
        }),
      },
      {
        nodeId: nonCollateralizedNodeId,
        chainName: 'anvil2',
        domainId: 31337,
        routerAddress: '0xrouterb',
        tokenAddress: '0xtokenb',
        tokenName: 'Synthetic Token',
        tokenSymbol: 'SYNTH',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: false,
          decimals: 6,
        }),
      },
    ];

    const pendingTransfersClient: Pick<
      ExplorerPendingTransfersClient,
      'getPendingDestinationTransfers'
    > = {
      async getPendingDestinationTransfers() {
        return [
          {
            messageId: '0xmsg1',
            originDomainId: 31337,
            destinationDomainId: 31337,
            destinationChain: 'anvil2',
            destinationNodeId: collateralizedNodeId,
            destinationRouter: '0xroutera',
            amountBaseUnits: 2_000_000n,
          },
          {
            messageId: '0xmsg2',
            originDomainId: 31337,
            destinationDomainId: 31337,
            destinationChain: 'anvil2',
            destinationNodeId: nonCollateralizedNodeId,
            destinationRouter: '0xrouterb',
            amountBaseUnits: 2_000_000n,
          },
        ] satisfies PendingDestinationTransfer[];
      },
    };

    const collateralByNodeId = new Map<string, bigint>([
      [collateralizedNodeId, 1_000_000n],
      [nonCollateralizedNodeId, 1_000_000n],
    ]);

    await updatePendingAndInventoryMetrics(
      { multiProvider: {} } as WarpCore,
      routerNodes,
      collateralByNodeId,
      'MULTI/deficit-test',
      pendingTransfersClient as ExplorerPendingTransfersClient,
      200,
      undefined,
    );

    const metrics = await metricsRegister.metrics();
    const pendingLines = metrics
      .split('\n')
      .filter((line) =>
        line.startsWith('hyperlane_warp_route_pending_destination_amount{'),
      );
    expect(
      pendingLines.some((line) =>
        line.includes(`node_id="${collateralizedNodeId}"`),
      ),
    ).to.equal(true);
    expect(
      pendingLines.some((line) =>
        line.includes(`node_id="${nonCollateralizedNodeId}"`),
      ),
    ).to.equal(true);

    const projectedLines = metrics
      .split('\n')
      .filter((line) =>
        line.startsWith('hyperlane_warp_route_projected_deficit{'),
      );
    expect(
      projectedLines.some((line) =>
        line.includes(`node_id="${collateralizedNodeId}"`),
      ),
    ).to.equal(true);
    expect(
      projectedLines.some((line) =>
        line.includes(`node_id="${nonCollateralizedNodeId}"`),
      ),
    ).to.equal(false);
  });

  it('does not emit inventory metrics when balance read fails', async () => {
    const nodeId = 'COLLAT|anvil2|0xroutera';
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId,
        chainName: 'anvil2',
        domainId: 31337,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'Collateral Token',
        tokenSymbol: 'COLLAT',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          getBalance: async () => {
            throw new Error('rpc down');
          },
        }),
      },
    ];

    const pendingTransfersClient: Pick<
      ExplorerPendingTransfersClient,
      'getPendingDestinationTransfers'
    > = {
      async getPendingDestinationTransfers() {
        return [] as PendingDestinationTransfer[];
      },
    };

    await updatePendingAndInventoryMetrics(
      { multiProvider: {} } as WarpCore,
      routerNodes,
      new Map([[nodeId, 1_000_000n]]),
      'MULTI/inventory-fail-test',
      pendingTransfersClient as ExplorerPendingTransfersClient,
      200,
      '0x1111111111111111111111111111111111111111',
    );

    const metrics = await metricsRegister.metrics();
    const inventoryLines = metrics
      .split('\n')
      .filter((line) =>
        line.startsWith('hyperlane_warp_route_inventory_balance{'),
      );
    expect(
      inventoryLines.some((line) => line.includes(`node_id="${nodeId}"`)),
    ).to.equal(false);
  });

  it('leaves pending series stale (does not publish zeroes) and still updates inventory when explorer query fails', async () => {
    const nodeId = 'COLLAT|anvil2|0xroutera';
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId,
        chainName: 'anvil2',
        domainId: 31337,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'Collateral Token',
        tokenSymbol: 'COLLAT',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          getBalance: async () => 1_000_000n,
        }),
      },
    ];

    const pendingTransfersClient: Pick<
      ExplorerPendingTransfersClient,
      'getPendingDestinationTransfers'
    > = {
      async getPendingDestinationTransfers() {
        throw new Error('explorer down');
      },
    };

    await updatePendingAndInventoryMetrics(
      { multiProvider: {} } as WarpCore,
      routerNodes,
      new Map([[nodeId, 2_000_000n]]),
      'MULTI/explorer-fail-test',
      pendingTransfersClient as ExplorerPendingTransfersClient,
      200,
      '0x1111111111111111111111111111111111111111',
    );

    const metrics = await metricsRegister.metrics();
    const pendingAmountLine = metrics
      .split('\n')
      .find(
        (line) =>
          line.startsWith('hyperlane_warp_route_pending_destination_amount{') &&
          line.includes(`node_id="${nodeId}"`),
      );
    // A failed explorer query must NOT publish confident zeroes; with no prior
    // series the pending gauge stays absent for this node rather than reading
    // "all clear" and silencing deficit alerting during the outage.
    expect(pendingAmountLine).to.equal(undefined);

    const inventoryLine = metrics
      .split('\n')
      .find(
        (line) =>
          line.startsWith('hyperlane_warp_route_inventory_balance{') &&
          line.includes(`node_id="${nodeId}"`),
      );
    expect(inventoryLine).to.exist;
    expect(inventoryLine!.trim().endsWith(' 1')).to.equal(true);
  });

  it('preserves last-good inventory for a node whose balance read fails on a later cycle', async () => {
    const inventoryAddress = '0x1111111111111111111111111111111111111111';
    const stableNodeId = 'COLLAT|anvil2|0xroutera';
    const flakyNodeId = 'COLLAT|anvil2|0xrouterb';

    let flakyCalls = 0;
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId: stableNodeId,
        chainName: 'anvil2',
        domainId: 31337,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'Collateral Token A',
        tokenSymbol: 'COLLAT',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          getBalance: async () => 5_000_000n,
        }),
      },
      {
        nodeId: flakyNodeId,
        chainName: 'anvil2',
        domainId: 31337,
        routerAddress: '0xrouterb',
        tokenAddress: '0xtokenb',
        tokenName: 'Collateral Token B',
        tokenSymbol: 'COLLAT',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          getBalance: async () => {
            flakyCalls += 1;
            if (flakyCalls > 1) throw new Error('rpc down');
            return 7_000_000n;
          },
        }),
      },
    ];

    const pendingTransfersClient: Pick<
      ExplorerPendingTransfersClient,
      'getPendingDestinationTransfers'
    > = {
      async getPendingDestinationTransfers() {
        return [] as PendingDestinationTransfer[];
      },
    };

    const collateralByNodeId = new Map<string, bigint>([
      [stableNodeId, 5_000_000n],
      [flakyNodeId, 7_000_000n],
    ]);

    const runCycle = async () =>
      updatePendingAndInventoryMetrics(
        { multiProvider: {} } as WarpCore,
        routerNodes,
        collateralByNodeId,
        'MULTI/inventory-stale-test',
        pendingTransfersClient as ExplorerPendingTransfersClient,
        200,
        inventoryAddress,
      );

    // First cycle: both nodes read successfully. Second cycle: flaky node fails.
    await runCycle();
    await runCycle();

    const metrics = await metricsRegister.metrics();
    const flakyLine = metrics
      .split('\n')
      .find(
        (line) =>
          line.startsWith('hyperlane_warp_route_inventory_balance{') &&
          line.includes(`node_id="${flakyNodeId}"`),
      );
    // A transient RPC failure must not silence the metric: the flaky node keeps
    // its last-good value (7) rather than being removed.
    expect(flakyLine).to.exist;
    expect(flakyLine!.trim().endsWith(' 7')).to.equal(true);

    const stableLine = metrics
      .split('\n')
      .find(
        (line) =>
          line.startsWith('hyperlane_warp_route_inventory_balance{') &&
          line.includes(`node_id="${stableNodeId}"`),
      );
    expect(stableLine).to.exist;
    expect(stableLine!.trim().endsWith(' 5')).to.equal(true);
  });
});
