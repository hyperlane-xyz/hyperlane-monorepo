import { expect } from 'chai';

import type { IRegistry } from '@hyperlane-xyz/registry';
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
import { WarpMonitor } from './monitor.js';

function createMockToken({
  collateralized,
  decimals,
}: {
  collateralized: boolean;
  decimals: number;
}): Pick<Token, 'isCollateralized' | 'amount' | 'getAdapter'> {
  return {
    isCollateralized: () => collateralized,
    amount: (amount: bigint) => ({
      getDecimalFormattedAmount: () => Number(amount) / 10 ** decimals,
    }),
    getAdapter: () => ({
      getBalance: async () => 0n,
    }),
  };
}

describe('WarpMonitor', () => {
  afterEach(() => {
    resetPendingDestinationMetrics();
    resetInventoryBalanceMetrics();
  });

  it('emits projected deficit metrics only for collateralized nodes', async () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'MULTI/deficit-test',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const collateralizedNodeId = 'COLLAT|anvil2|0xroutera';
    const nonCollateralizedNodeId = 'SYNTH|anvil2|0xrouterb';
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId: collateralizedNodeId,
        chainName: 'anvil2' as RouterNodeMetadata['chainName'],
        domainId: 31337,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'Collateral Token',
        tokenSymbol: 'COLLAT',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
        }) as unknown as Token,
      },
      {
        nodeId: nonCollateralizedNodeId,
        chainName: 'anvil2' as RouterNodeMetadata['chainName'],
        domainId: 31337,
        routerAddress: '0xrouterb',
        tokenAddress: '0xtokenb',
        tokenName: 'Synthetic Token',
        tokenSymbol: 'SYNTH',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: false,
          decimals: 6,
        }) as unknown as Token,
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

    await (
      monitor as unknown as WarpMonitor & {
        updatePendingAndInventoryMetrics: (
          warpCore: WarpCore,
          routerNodes: RouterNodeMetadata[],
          collateralByNodeId: Map<string, bigint>,
          warpRouteId: string,
          pendingTransfersClient?: ExplorerPendingTransfersClient,
          explorerQueryLimit?: number,
          inventoryAddress?: string,
        ) => Promise<void>;
      }
    ).updatePendingAndInventoryMetrics(
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
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'MULTI/inventory-fail-test',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const nodeId = 'COLLAT|anvil2|0xroutera';
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId,
        chainName: 'anvil2' as RouterNodeMetadata['chainName'],
        domainId: 31337,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'Collateral Token',
        tokenSymbol: 'COLLAT',
        tokenDecimals: 6,
        token: {
          isCollateralized: () => true,
          amount: (amount: bigint) => ({
            getDecimalFormattedAmount: () => Number(amount) / 10 ** 6,
          }),
          getAdapter: () => ({
            getBalance: async () => {
              throw new Error('rpc down');
            },
          }),
        } as unknown as Token,
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

    await (
      monitor as unknown as WarpMonitor & {
        updatePendingAndInventoryMetrics: (
          warpCore: WarpCore,
          routerNodes: RouterNodeMetadata[],
          collateralByNodeId: Map<string, bigint>,
          warpRouteId: string,
          pendingTransfersClient?: ExplorerPendingTransfersClient,
          explorerQueryLimit?: number,
          inventoryAddress?: string,
        ) => Promise<void>;
      }
    ).updatePendingAndInventoryMetrics(
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
});
