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
  protocol = ProtocolType.Ethereum,
}: {
  collateralized: boolean;
  decimals: number;
  getBalance?: (address: string) => Promise<bigint>;
  protocol?: ProtocolType;
}): Token {
  return {
    protocol,
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

function invokeBuildRouterNodes(
  monitor: WarpMonitor,
  warpCore: WarpCore,
  chainMetadata: Record<string, { domainId: number }>,
): RouterNodeMetadata[] {
  const buildRouterNodes = (monitor as any).buildRouterNodes as (
    warpCore: WarpCore,
    chainMetadata: Record<string, { domainId: number }>,
  ) => RouterNodeMetadata[];

  return buildRouterNodes.call(monitor, warpCore, chainMetadata);
}

function invokeBuildExplorerRouterNodes(
  monitor: WarpMonitor,
  routerNodes: RouterNodeMetadata[],
): RouterNodeMetadata[] {
  const buildExplorerRouterNodes = (monitor as any)
    .buildExplorerRouterNodes as (
    routerNodes: RouterNodeMetadata[],
  ) => RouterNodeMetadata[];

  return buildExplorerRouterNodes.call(monitor, routerNodes);
}

describe('WarpMonitor', () => {
  afterEach(() => {
    delete process.env.INVENTORY_ADDRESS_ETHEREUM;
    delete process.env.INVENTORY_ADDRESS_SEALEVEL;
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

  it('includes Solana cross-collateral nodes without lowercasing base58 addresses', () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'CROSS/ctusd',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const evmToken = {
      symbol: 'USDC',
      chainName: 'ethereum',
      addressOrDenom: '0xd4463cB3c90b3F49c673310BEC9bC18311134B47',
      collateralAddressOrDenom: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      name: 'USD Coin',
      protocol: ProtocolType.Ethereum,
    } as Token;
    const solanaToken = {
      symbol: 'USDC',
      chainName: 'solanamainnet',
      addressOrDenom: 'HxwQM6D6FpqZJkemVKyhQpD2k8cHefg1PG4iWH5aXdrr',
      collateralAddressOrDenom: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
      name: 'USD Coin',
      protocol: ProtocolType.Sealevel,
    } as Token;

    const nodes = invokeBuildRouterNodes(
      monitor,
      { tokens: [evmToken, solanaToken] } as WarpCore,
      {
        ethereum: { domainId: 1 },
        solanamainnet: { domainId: 1399811149 },
      },
    );

    expect(nodes).to.have.length(2);
    expect(nodes.map((node) => node.nodeId)).to.include(
      'USDC|solanamainnet|HxwQM6D6FpqZJkemVKyhQpD2k8cHefg1PG4iWH5aXdrr',
    );
    expect(nodes.map((node) => node.routerAddress)).to.include(
      'HxwQM6D6FpqZJkemVKyhQpD2k8cHefg1PG4iWH5aXdrr',
    );
    expect(nodes.map((node) => node.tokenAddress)).to.include(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(nodes.map((node) => node.routerAddress)).to.include(
      '0xd4463cb3c90b3f49c673310bec9bc18311134b47',
    );
  });

  it('skips Ethereum nodes with malformed router addresses', () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'CROSS/ctusd',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const nodes = invokeBuildRouterNodes(
      monitor,
      {
        tokens: [
          {
            symbol: 'USDC',
            chainName: 'ethereum',
            addressOrDenom: 'not-an-evm-address',
            collateralAddressOrDenom:
              '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            decimals: 6,
            name: 'USD Coin',
            protocol: ProtocolType.Ethereum,
          } as Token,
        ],
      } as WarpCore,
      {
        ethereum: { domainId: 1 },
      },
    );

    expect(nodes).to.have.length(0);
  });

  it('skips Ethereum nodes with malformed collateral addresses', () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'CROSS/ctusd',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const nodes = invokeBuildRouterNodes(
      monitor,
      {
        tokens: [
          {
            symbol: 'USDC',
            chainName: 'ethereum',
            addressOrDenom: '0xd4463cB3c90b3F49c673310BEC9bC18311134B47',
            collateralAddressOrDenom: 'not-an-evm-address',
            decimals: 6,
            name: 'USD Coin',
            protocol: ProtocolType.Ethereum,
          } as Token,
        ],
      } as WarpCore,
      {
        ethereum: { domainId: 1 },
      },
    );

    expect(nodes).to.have.length(0);
  });

  it('excludes Solana router nodes from explorer queries', () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'CROSS/ctusd',
        checkFrequency: 10_000,
        explorerApiUrl: 'https://explorer.example/graphql',
      },
      {} as IRegistry,
    );

    const evmNodeId = 'USDC|base|0x1234567890123456789012345678901234567890';
    const sealevelNodeId =
      'USDC|solanamainnet|SolRouter1111111111111111111111111111111';
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId: evmNodeId,
        chainName: 'base' as RouterNodeMetadata['chainName'],
        domainId: 8453,
        routerAddress: '0x1234567890123456789012345678901234567890',
        tokenAddress: '0xabcdef1234567890123456789012345678901234',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          protocol: ProtocolType.Ethereum,
        }),
      },
      {
        nodeId: sealevelNodeId,
        chainName: 'solanamainnet' as RouterNodeMetadata['chainName'],
        domainId: 1399811149,
        routerAddress: 'SolRouter1111111111111111111111111111111',
        tokenAddress: 'SolMint1111111111111111111111111111111111',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          protocol: ProtocolType.Sealevel,
        }),
      },
    ];

    const explorerRouterNodes = invokeBuildExplorerRouterNodes(
      monitor,
      routerNodes,
    );

    expect(explorerRouterNodes.map((node) => node.nodeId)).to.deep.equal([
      evmNodeId,
    ]);
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

  it('uses protocol-specific inventory addresses when configured', async () => {
    process.env.INVENTORY_ADDRESS_ETHEREUM =
      '0xEA2117b24F7947647Bec60527B68f4244AE40c01';
    process.env.INVENTORY_ADDRESS_SEALEVEL =
      'EqC3NZkibWavWcT6HnU8tz4jiFxTEayKQyEPz3KZU4uc';

    const monitor = new WarpMonitor(
      {
        warpRouteId: 'CROSS/ctusd',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const evmNodeId = 'USDC|base|0xroutera';
    const sealevelNodeId =
      'USDC|solanamainnet|SolRouter1111111111111111111111111111111';
    const calls: string[] = [];
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId: evmNodeId,
        chainName: 'base' as RouterNodeMetadata['chainName'],
        domainId: 8453,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          getBalance: async (address: string) => {
            calls.push(address);
            return 2_000_000n;
          },
        }),
      },
      {
        nodeId: sealevelNodeId,
        chainName: 'solanamainnet' as RouterNodeMetadata['chainName'],
        domainId: 1399811149,
        routerAddress: 'SolRouter1111111111111111111111111111111',
        tokenAddress: 'SolMint1111111111111111111111111111111111',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          protocol: ProtocolType.Sealevel,
          getBalance: async (address: string) => {
            calls.push(address);
            return 3_000_000n;
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
      new Map(),
      'CROSS/ctusd',
      pendingTransfersClient as ExplorerPendingTransfersClient,
      200,
    );

    expect(calls).to.deep.equal([
      '0xEA2117b24F7947647Bec60527B68f4244AE40c01',
      'EqC3NZkibWavWcT6HnU8tz4jiFxTEayKQyEPz3KZU4uc',
    ]);
  });

  it('does not use the global inventory address for Sealevel nodes', async () => {
    const monitor = new WarpMonitor(
      {
        warpRouteId: 'CROSS/ctusd',
        checkFrequency: 10_000,
      },
      {} as IRegistry,
    );

    const evmNodeId = 'USDC|base|0xroutera';
    const sealevelNodeId =
      'USDC|solanamainnet|SolRouter1111111111111111111111111111111';
    const calls: string[] = [];
    const routerNodes: RouterNodeMetadata[] = [
      {
        nodeId: evmNodeId,
        chainName: 'base' as RouterNodeMetadata['chainName'],
        domainId: 8453,
        routerAddress: '0xroutera',
        tokenAddress: '0xtokena',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          getBalance: async (address: string) => {
            calls.push(`evm:${address}`);
            return 2_000_000n;
          },
        }),
      },
      {
        nodeId: sealevelNodeId,
        chainName: 'solanamainnet' as RouterNodeMetadata['chainName'],
        domainId: 1399811149,
        routerAddress: 'SolRouter1111111111111111111111111111111',
        tokenAddress: 'SolMint1111111111111111111111111111111111',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        token: createMockToken({
          collateralized: true,
          decimals: 6,
          protocol: ProtocolType.Sealevel,
          getBalance: async (address: string) => {
            calls.push(`sealevel:${address}`);
            return 3_000_000n;
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
      new Map(),
      'CROSS/ctusd',
      pendingTransfersClient as ExplorerPendingTransfersClient,
      200,
      '0xEA2117b24F7947647Bec60527B68f4244AE40c01',
    );

    expect(calls).to.deep.equal([
      'evm:0xEA2117b24F7947647Bec60527B68f4244AE40c01',
    ]);
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
});
