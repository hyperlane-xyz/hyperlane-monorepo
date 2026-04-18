import { expect } from 'chai';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type { Token, WarpCore } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';
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

async function invokeUpdatePendingAndInventoryMetrics(
  monitor: WarpMonitor,
  warpCore: WarpCore,
  routerNodes: RouterNodeMetadata[],
  collateralByNodeId: Map<string, bigint>,
  warpRouteId: string,
  pendingTransfersClient?: ExplorerPendingTransfersClient,
  explorerQueryLimit?: number,
  inventoryAddress?: string,
) {
  const updatePendingAndInventoryMetrics = (monitor as any)
    .updatePendingAndInventoryMetrics as (
    warpCore: WarpCore,
    routerNodes: RouterNodeMetadata[],
    collateralByNodeId: Map<string, bigint>,
    warpRouteId: string,
    pendingTransfersClient?: ExplorerPendingTransfersClient,
    explorerQueryLimit?: number,
    inventoryAddress?: string,
  ) => Promise<void>;

  await updatePendingAndInventoryMetrics.call(
    monitor,
    warpCore,
    routerNodes,
    collateralByNodeId,
    warpRouteId,
    pendingTransfersClient,
    explorerQueryLimit,
    inventoryAddress,
  );
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
        }),
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

    await invokeUpdatePendingAndInventoryMetrics(
      monitor,
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

    await invokeUpdatePendingAndInventoryMetrics(
      monitor,
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

  it('resets pending metrics and still updates inventory when explorer query fails', async () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'MULTI/explorer-fail-test',
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

    await invokeUpdatePendingAndInventoryMetrics(
      monitor,
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
    expect(pendingAmountLine).to.exist;
    expect(pendingAmountLine!.trim().endsWith(' 0')).to.equal(true);

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

  it('builds router nodes for non-evm tokens so their domains reach explorer queries', () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'MULTI/sealevel-origin-test',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const buildRouterNodes = (monitor as any).buildRouterNodes as (
      warpCore: WarpCore,
      chainMetadata: Record<string, { domainId: number }>,
    ) => RouterNodeMetadata[];

    const routerNodes = buildRouterNodes.call(
      monitor,
      {
        tokens: [
          {
            chainName: 'base',
            addressOrDenom: '0x00000000000000000000000000000000000000AA',
            collateralAddressOrDenom:
              '0x00000000000000000000000000000000000000BB',
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
            scale: 1_000_000_000_000,
          },
          {
            chainName: 'solanamainnet',
            addressOrDenom: 'So11111111111111111111111111111111111111112',
            collateralAddressOrDenom:
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
            scale: 1_000_000_000_000,
            protocol: ProtocolType.Sealevel,
          },
        ] as Token[],
      } as WarpCore,
      {
        base: { domainId: 8453 },
        solanamainnet: { domainId: 1399811149 },
      },
    );

    expect(routerNodes.map((node) => node.domainId)).to.deep.equal([
      8453, 1399811149,
    ]);
    expect(routerNodes.map((node) => node.routerAddress)).to.deep.equal([
      '0x00000000000000000000000000000000000000aa',
      'So11111111111111111111111111111111111111112',
    ]);
    expect(routerNodes.map((node) => node.nodeId)).to.deep.equal([
      'USDC|base|0x00000000000000000000000000000000000000aa',
      'USDC|solanamainnet|So11111111111111111111111111111111111111112',
    ]);
  });
});
