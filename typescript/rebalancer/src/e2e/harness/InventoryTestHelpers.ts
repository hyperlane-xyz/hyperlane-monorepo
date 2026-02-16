import { BigNumber, ethers, providers } from 'ethers';
import { type Logger, pino } from 'pino';

import { ERC20__factory, ERC20Test__factory } from '@hyperlane-xyz/core';
import { type ChainName, type ChainMap, HyperlaneCore } from '@hyperlane-xyz/sdk';

import { ExternalBridgeType } from '../../config/types.js';
import { InventoryRebalancer } from '../../core/InventoryRebalancer.js';
import { type CycleResult } from '../../core/RebalancerOrchestrator.js';
import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferStatus,
  IExternalBridge,
} from '../../interfaces/IExternalBridge.js';
import type { MonitorEvent } from '../../interfaces/IMonitor.js';
import type { RebalanceAction } from '../../tracking/types.js';
import {
  ANVIL_TEST_PRIVATE_KEY,
  DOMAIN_IDS,
  TEST_CHAINS,
  type DeployedAddresses,
  type TestChain,
} from '../fixtures/routes.js';

import { getFirstMonitorEvent } from './TestHelpers.js';
import type { TestRebalancerContext } from './TestRebalancer.js';
import { tryRelayMessage } from './TransferHelper.js';

const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface BridgeExecutionPlan {
  executeError?: string;
  statusSequence?: BridgeTransferStatus[];
}

export class ScriptedBridgeMock implements IExternalBridge {
  readonly externalBridgeId = ExternalBridgeType.LiFi;
  readonly logger = pino({ level: 'silent' });

  private txCounter = 1;
  private readonly plans: BridgeExecutionPlan[] = [];
  private readonly statusByTxHash = new Map<string, BridgeTransferStatus[]>();

  public readonly quoteCalls: BridgeQuoteParams[] = [];
  public readonly executeCalls: Array<{
    txHash: string;
    fromChain: number;
    toChain: number;
    fromAmount: bigint;
    toAmount: bigint;
  }> = [];

  enqueuePlan(plan: BridgeExecutionPlan): void {
    this.plans.push(plan);
  }

  getNativeTokenAddress(): string {
    return NATIVE_TOKEN_ADDRESS;
  }

  async quote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    this.quoteCalls.push(params);

    const fromAmount = params.fromAmount ?? params.toAmount ?? 0n;
    const toAmount = params.toAmount ?? (fromAmount * 98n) / 100n;

    return {
      id: `quote-${this.quoteCalls.length}`,
      tool: 'scripted-bridge',
      fromAmount,
      toAmount,
      toAmountMin: (toAmount * 99n) / 100n,
      executionDuration: 30,
      gasCosts: 0n,
      feeCosts: 0n,
      route: {
        action: {
          fromChainId: params.fromChain,
          toChainId: params.toChain,
        },
      },
    };
  }

  async execute(quote: BridgeQuote, _signer: unknown): Promise<{
    txHash: string;
    fromChain: number;
    toChain: number;
    transferId?: string;
  }> {
    const plan = this.plans.shift();
    if (plan?.executeError) {
      throw new Error(plan.executeError);
    }

    const txHash = this.formatTxHash(this.txCounter++);
    const route = quote.route as {
      action?: { fromChainId?: number; toChainId?: number };
    };

    const fromChain = route.action?.fromChainId ?? 0;
    const toChain = route.action?.toChainId ?? 0;
    const statusSequence = plan?.statusSequence ?? [
      {
        status: 'complete',
        receivingTxHash: this.formatTxHash(10_000 + this.txCounter),
        receivedAmount: quote.toAmount,
      },
    ];
    this.statusByTxHash.set(txHash, [...statusSequence]);

    this.executeCalls.push({
      txHash,
      fromChain,
      toChain,
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
    });

    return {
      txHash,
      fromChain,
      toChain,
      transferId: `transfer-${this.executeCalls.length}`,
    };
  }

  async getStatus(
    txHash: string,
    _fromChain: number,
    _toChain: number,
  ): Promise<BridgeTransferStatus> {
    const sequence = this.statusByTxHash.get(txHash);
    if (!sequence || sequence.length === 0) {
      return { status: 'not_found' };
    }

    if (sequence.length > 1) {
      return sequence.shift()!;
    }

    return sequence[0];
  }

  private formatTxHash(seed: number): string {
    return `0x${seed.toString(16).padStart(64, '0')}`;
  }
}

export function inventoryBalances(
  overrides: Partial<Record<TestChain, bigint>>,
): Record<TestChain, bigint> {
  return {
    anvil1: 0n,
    anvil2: 0n,
    anvil3: 0n,
    ...overrides,
  };
}

export async function approveInventorySignerForMonitoredRoutes(
  localProviders: Map<string, providers.JsonRpcProvider>,
  deployedAddresses: DeployedAddresses,
  inventorySignerKey: string = ANVIL_TEST_PRIVATE_KEY,
): Promise<string> {
  const wallet = new ethers.Wallet(inventorySignerKey);
  const inventorySignerAddress = wallet.address;

  for (const chain of TEST_CHAINS) {
    const provider = localProviders.get(chain);
    if (!provider) {
      throw new Error(`Provider not found for chain ${chain}`);
    }

    const signer = wallet.connect(provider);
    const token = ERC20__factory.connect(deployedAddresses.tokens[chain], signer);
    const routerAddress = deployedAddresses.monitoredRoute[chain];
    const allowance = await token.allowance(inventorySignerAddress, routerAddress);

    if (allowance.lt(ethers.constants.MaxUint256.div(2))) {
      const tx = await token.approve(routerAddress, ethers.constants.MaxUint256);
      await tx.wait();
    }
  }

  return inventorySignerAddress;
}

export async function setInventorySignerBalances(
  localProviders: Map<string, providers.JsonRpcProvider>,
  deployedAddresses: DeployedAddresses,
  inventorySignerAddress: string,
  balancesByChain: Record<TestChain, bigint>,
): Promise<void> {
  for (const chain of TEST_CHAINS) {
    const provider = localProviders.get(chain);
    if (!provider) {
      throw new Error(`Provider not found for chain ${chain}`);
    }

    const deployer = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider);
    const token = ERC20Test__factory.connect(
      deployedAddresses.tokens[chain],
      deployer,
    );
    const current = await token.balanceOf(inventorySignerAddress);
    const target = BigNumber.from(balancesByChain[chain].toString());

    if (current.gt(target)) {
      const burnTx = await token.burnFrom(inventorySignerAddress, current.sub(target));
      await burnTx.wait();
    } else if (current.lt(target)) {
      const mintTx = await token.mintTo(inventorySignerAddress, target.sub(current));
      await mintTx.wait();
    }
  }
}

export async function readInventorySignerBalances(
  localProviders: Map<string, providers.JsonRpcProvider>,
  deployedAddresses: DeployedAddresses,
  inventorySignerAddress: string,
): Promise<ChainMap<bigint>> {
  const balances: ChainMap<bigint> = {};

  for (const chain of TEST_CHAINS) {
    const provider = localProviders.get(chain);
    if (!provider) {
      throw new Error(`Provider not found for chain ${chain}`);
    }

    const token = ERC20__factory.connect(deployedAddresses.tokens[chain], provider);
    const balance = await token.balanceOf(inventorySignerAddress);
    balances[chain] = balance.toBigInt();
  }

  return balances;
}

export async function buildInventoryMonitorEvent(
  context: TestRebalancerContext,
  localProviders: Map<string, providers.JsonRpcProvider>,
  deployedAddresses: DeployedAddresses,
  inventorySignerAddress: string,
): Promise<MonitorEvent> {
  const monitor = context.createMonitor(0);
  const event = await getFirstMonitorEvent(monitor);
  event.inventoryBalances = await readInventorySignerBalances(
    localProviders,
    deployedAddresses,
    inventorySignerAddress,
  );
  return event;
}

export async function executeInventoryCycle(
  context: TestRebalancerContext,
  localProviders: Map<string, providers.JsonRpcProvider>,
  deployedAddresses: DeployedAddresses,
  inventorySignerAddress: string,
): Promise<CycleResult> {
  const event = await buildInventoryMonitorEvent(
    context,
    localProviders,
    deployedAddresses,
    inventorySignerAddress,
  );
  return context.orchestrator.executeCycle(event);
}

export function injectInventoryRebalancer(
  context: TestRebalancerContext,
  bridge: IExternalBridge,
  inventorySignerAddress: string,
  inventoryChains: ChainName[] = TEST_CHAINS as unknown as ChainName[],
): InventoryRebalancer {
  type MutableOrchestrator = {
    rebalancersByType: Map<string, unknown>;
    externalBridgeRegistry?: Record<string, unknown>;
    logger: Logger;
  };

  const mutableOrchestrator =
    context.orchestrator as unknown as MutableOrchestrator;

  const inventoryRebalancer = new InventoryRebalancer(
    {
      inventorySigner: inventorySignerAddress,
      inventoryChains,
    },
    context.tracker,
    {
      [ExternalBridgeType.LiFi]: bridge,
    },
    context.contextFactory.getWarpCore(),
    context.multiProvider,
    mutableOrchestrator.logger,
  );

  mutableOrchestrator.rebalancersByType.set('inventory', inventoryRebalancer);
  mutableOrchestrator.externalBridgeRegistry = {
    [ExternalBridgeType.LiFi]: bridge,
  };

  return inventoryRebalancer;
}

export function getChainFromDomain(domain: number): TestChain {
  const entry = Object.entries(DOMAIN_IDS).find(([, id]) => id === domain);
  if (!entry) {
    throw new Error(`Unknown domain ${domain}`);
  }
  return entry[0] as TestChain;
}

export async function relayInventoryDepositAction(
  action: RebalanceAction,
  context: TestRebalancerContext,
  localProviders: Map<string, providers.JsonRpcProvider>,
  hyperlaneCore: HyperlaneCore,
): Promise<void> {
  if (!action.txHash || !action.messageId) {
    throw new Error(`Action ${action.id} missing txHash or messageId`);
  }

  const origin = getChainFromDomain(action.origin);
  const destination = getChainFromDomain(action.destination);
  const originProvider = localProviders.get(origin);
  if (!originProvider) {
    throw new Error(`Provider not found for origin chain ${origin}`);
  }

  const receipt = await originProvider.getTransactionReceipt(action.txHash);
  const relayResult = await tryRelayMessage(context.multiProvider, hyperlaneCore, {
    dispatchTx: receipt,
    messageId: action.messageId,
    origin,
    destination,
  });

  if (!relayResult.success) {
    throw new Error(
      `Inventory action relay failed (${action.id}): ${relayResult.error}`,
    );
  }
}
