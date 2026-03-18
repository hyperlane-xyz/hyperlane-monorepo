import { Connection, PublicKey } from '@solana/web3.js';
import { providers } from 'ethers';

import { HyperlaneCore, MultiProvider, snapshot } from '@hyperlane-xyz/sdk';

import { TEST_CHAINS } from '../fixtures/routes.js';
import { MAILBOX_PROGRAM_ID } from '../fixtures/svm-routes.js';
import {
  MockExternalBridge,
  type SvmBridgeContext,
} from './MockExternalBridge.js';
import { resetSnapshotsAndRefreshProviders } from './SnapshotHelper.js';
import { SvmCollateralEvmErc20LocalDeploymentManager } from './SvmCollateralEvmErc20LocalDeploymentManager.js';
import { getFirstMonitorEvent } from './TestHelpers.js';
import type { TestRebalancerContext } from './TestRebalancer.js';

export interface MixedCollateralTestSetup {
  manager: SvmCollateralEvmErc20LocalDeploymentManager;
  svmConnection: Connection;
  localProviders: Map<string, providers.JsonRpcProvider>;
  multiProvider: MultiProvider;
  hyperlaneCore: HyperlaneCore;
  mockBridge: MockExternalBridge;
  snapshotIds: Map<string, string>;
}

export async function createMixedCollateralTestSetup(
  svmPort: number,
): Promise<MixedCollateralTestSetup> {
  const manager = new SvmCollateralEvmErc20LocalDeploymentManager(
    undefined,
    svmPort,
  );
  await manager.setup();

  const addresses = manager.getDeployedAddresses();
  const svmConnection = manager.getSvmChainManager().getConnection();

  const evmCtx = manager.getEvmDeploymentManager().getContext();
  const localProviders = evmCtx.providers;
  const multiProvider = evmCtx.multiProvider;

  const coreAddresses: Record<string, Record<string, string>> = {};
  for (const chain of TEST_CHAINS) {
    coreAddresses[chain] = {
      mailbox: addresses.chains[chain].mailbox,
      interchainSecurityModule: addresses.chains[chain].ism,
    };
  }
  const hyperlaneCore = HyperlaneCore.fromAddressesMap(
    coreAddresses,
    multiProvider,
  );

  const svmAddresses = addresses.svm;
  const svmBridgeCtx: SvmBridgeContext | undefined = svmAddresses.bridgeRouter
    ? {
        connection: svmConnection,
        warpRouter: svmAddresses.bridgeRouter,
        mailboxProgramId: MAILBOX_PROGRAM_ID,
        mpp: manager.getMultiProtocolProvider(),
        deployerKeypair: manager.getSvmChainManager().getDeployerKeypair(),
        evmCore: hyperlaneCore,
        evmMultiProvider: multiProvider,
        tokenType: 'collateral',
        collateralMint: svmAddresses.splMint,
      }
    : undefined;

  const mockBridge = new MockExternalBridge(
    addresses,
    multiProvider,
    hyperlaneCore,
    'erc20',
    undefined,
    svmBridgeCtx,
  );

  const snapshotIds = new Map<string, string>();
  for (const [chain, provider] of localProviders) {
    snapshotIds.set(chain, await snapshot(provider));
  }

  return {
    manager,
    svmConnection,
    localProviders,
    multiProvider,
    hyperlaneCore,
    mockBridge,
    snapshotIds,
  };
}

export async function resetMixedCollateralTestState(
  setup: MixedCollateralTestSetup,
): Promise<void> {
  setup.mockBridge.reset();
  await resetSnapshotsAndRefreshProviders({
    localProviders: setup.localProviders,
    multiProvider: setup.multiProvider,
    snapshotIds: setup.snapshotIds,
  });
}

export async function teardownMixedCollateralTest(
  setup: MixedCollateralTestSetup | undefined,
): Promise<void> {
  if (setup?.manager) {
    await setup.manager.teardown();
  }
}

export function normalizeMessageId(id: string): string {
  const lower = id.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

export async function getSvmEscrowBalance(
  connection: Connection,
  escrowPda: string,
): Promise<bigint> {
  const result = await connection.getTokenAccountBalance(
    new PublicKey(escrowPda),
    'confirmed',
  );
  return BigInt(result.value.amount);
}

export async function executeCycle(
  context: TestRebalancerContext,
): Promise<void> {
  const monitor = context.createMonitor(0);
  const event = await getFirstMonitorEvent(monitor);
  await context.orchestrator.executeCycle(event);
}
