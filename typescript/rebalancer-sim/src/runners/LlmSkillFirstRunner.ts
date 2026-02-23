import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { pino } from 'pino';

import {
  ERC20Test__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';
import {
  FakeRuntime,
  SkillFirstLoop,
  SqliteAdapter,
  StateStore,
  type LlmRebalancerConfig,
  type SkillProfile,
} from '@hyperlane-xyz/llm-rebalancer';
import { rootLogger } from '@hyperlane-xyz/utils';

import type {
  IRebalancerRunner,
  RebalancerEvent,
  RebalancerSimConfig,
} from '../types.js';

import { MockActionTracker } from './MockActionTracker.js';
import { SimulationRegistry } from './SimulationRegistry.js';

const logger = rootLogger.child({ module: 'LlmSkillFirstRunner' });
const silentLogger = pino({ level: 'silent' });

const INFLIGHT_RPC_SKILL = 'inflight-rpc';
const INFLIGHT_EXPLORER_SKILL = 'inflight-explorer';
const INFLIGHT_HYBRID_SKILL = 'inflight-hybrid';

let currentRunner: LlmSkillFirstRunner | null = null;

type PlannedRunnerAction = {
  actionFingerprint: string;
  executionType: 'movableCollateral';
  routeId: string;
  origin: string;
  destination: string;
  sourceRouter: string;
  destinationRouter: string;
  amount: string;
  reason: string;
};

type InflightContextMessage = {
  type: 'user' | 'self';
  origin: string;
  destination: string;
  amount: string;
  status: string;
};

type OpenActionContext = {
  actionFingerprint: string;
  origin: string;
  destination: string;
  amount: string;
};

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timeout waiting for runner state transition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function cleanupLlmSkillFirstRunner(): Promise<void> {
  if (!currentRunner) return;
  const runner = currentRunner;
  currentRunner = null;
  try {
    await runner.stop();
  } catch (error) {
    logger.debug({ error }, 'cleanupLlmSkillFirstRunner: stop failed');
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export class LlmSkillFirstRunner
  extends EventEmitter
  implements IRebalancerRunner
{
  readonly name = 'LlmSkillFirstRunner';

  private config?: RebalancerSimConfig;
  private provider?: ethers.providers.JsonRpcProvider;
  private signer?: ethers.Wallet;
  private loop?: SkillFirstLoop;
  private store?: StateStore;
  private timer?: NodeJS.Timeout;
  private running = false;
  private activeCycles = 0;
  private dbPath?: string;
  private readonly preserveDb =
    process.env.LLM_SIM_PRESERVE_DB === '1' ||
    process.env.LLM_SIM_PRESERVE_DB === 'true';
  private routeId = 'SIM/simulation';
  private chainByDomain = new Map<number, string>();
  private readonly actionTracker = new MockActionTracker();
  private readonly profile: SkillProfile = {
    observe: 'observe',
    inflightRpc: INFLIGHT_RPC_SKILL,
    inflightExplorer: INFLIGHT_EXPLORER_SKILL,
    inflightHybrid: INFLIGHT_HYBRID_SKILL,
    executeMovable: 'execute-movable',
    executeInventoryLifi: 'execute-inventory-lifi',
    reconcile: 'reconcile',
    globalNetting: 'global-netting',
  };

  async initialize(config: RebalancerSimConfig): Promise<void> {
    await cleanupLlmSkillFirstRunner();

    this.config = config;
    this.actionTracker.clear();
    this.routeId = new SimulationRegistry(config.deployment).getWarpRouteId();
    this.chainByDomain.clear();

    for (const [chain, domain] of Object.entries(config.deployment.domains)) {
      this.chainByDomain.set(domain.domainId, chain);
    }

    this.provider = new ethers.providers.JsonRpcProvider(config.deployment.anvilRpc);
    this.provider.pollingInterval = 100;
    this.provider.polling = false;
    this.signer = new ethers.Wallet(config.deployment.rebalancerKey, this.provider);

    this.dbPath = join(tmpdir(), `hl-llm-sim-${Date.now()}-${randomUUID()}.db`);
    const sql = new SqliteAdapter(this.dbPath);
    this.store = new StateStore(sql);
    await this.store.initialize();
    logger.debug(
      { dbPath: this.dbPath, preserveDb: this.preserveDb },
      'Initialized LLM sim state store',
    );

    const llmConfig: LlmRebalancerConfig = {
      warpRouteIds: [this.routeId],
      registryUri: 'simulation://local',
      llmProvider: 'codex',
      llmModel: 'gpt-5',
      intervalMs: config.pollingFrequency,
      db: { url: `sqlite://${this.dbPath}` },
      inflightMode: 'hybrid',
      skills: { profile: this.profile },
      signerEnv: 'HYP_REBALANCER_KEY',
      inventorySignerEnv: 'HYP_INVENTORY_KEY',
      executionPaths: ['movableCollateral', 'inventory'],
      inventoryBridge: 'lifi',
      runtime: {
        type: 'pi-openclaw',
        command: 'simulated',
        argsTemplate: [],
        timeoutMs: 5000,
      },
    };

    const runtime = new FakeRuntime({
      [this.profile.observe]: async () => this.observe(),
      [INFLIGHT_RPC_SKILL]: async () => this.inflight('rpc'),
      [INFLIGHT_EXPLORER_SKILL]: async () => this.inflight('explorer'),
      [INFLIGHT_HYBRID_SKILL]: async () => this.inflight('hybrid'),
      [this.profile.globalNetting]: async (input) => this.plan(input),
      [this.profile.executeMovable]: async (input) =>
        this.executeRebalance(input),
      [this.profile.executeInventoryLifi]: async (input) =>
        this.executeRebalance(input),
      [this.profile.reconcile]: async (input) => this.reconcile(input),
    });

    this.loop = new SkillFirstLoop(
      llmConfig,
      this.profile,
      runtime,
      this.store,
      silentLogger,
    );
  }

  async start(): Promise<void> {
    if (!this.config || !this.loop) {
      throw new Error('LlmSkillFirstRunner not initialized');
    }
    if (this.running) return;

    await cleanupLlmSkillFirstRunner();

    this.running = true;
    currentRunner = this;

    await this.runCycle();
    this.timer = setInterval(() => {
      this.runCycle().catch((error) => {
        logger.error(
          {
            err: error,
            message:
              error instanceof Error ? error.message : String(error),
          },
          'LLM runner cycle failed',
        );
      });
    }, this.config.pollingFrequency);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.activeCycles > 0) {
      try {
        await waitFor(() => this.activeCycles === 0, 10000);
      } catch (error) {
        logger.debug({ error }, 'LLM runner stop timed out waiting for idle');
      }
    }

    if (currentRunner === this) {
      currentRunner = null;
    }

    if (this.store) {
      await this.store.close();
      this.store = undefined;
    }

    if (this.provider) {
      this.provider.removeAllListeners();
      this.provider.polling = false;
      this.provider = undefined;
    }

    this.signer = undefined;
    this.loop = undefined;
    this.config = undefined;

    if (this.dbPath) {
      if (this.preserveDb) {
        logger.info({ dbPath: this.dbPath }, 'Preserving LLM sim DB for debugging');
      } else {
        await rm(this.dbPath, { force: true });
      }
      this.dbPath = undefined;
    }

    this.removeAllListeners();
  }

  isActive(): boolean {
    return this.running && this.activeCycles > 0;
  }

  async waitForIdle(timeoutMs: number = 10000): Promise<void> {
    await waitFor(() => this.activeCycles === 0, timeoutMs);
  }

  getActionTracker(): MockActionTracker {
    return this.actionTracker;
  }

  private async runCycle(): Promise<void> {
    if (!this.running || !this.loop) return;
    if (this.activeCycles > 0) return;

    this.activeCycles++;
    try {
      await this.loop.runCycle();
    } finally {
      this.activeCycles--;
    }
  }

  private async observe(): Promise<{
    observedAt: number;
    routerBalances: Array<{
      routeId: string;
      chain: string;
      symbol: string;
      router: string;
      collateral: string;
      inventory: string;
    }>;
  }> {
    if (!this.config || !this.provider || !this.signer) {
      throw new Error('observe called before initialization');
    }

    const routerBalances: Array<{
      routeId: string;
      chain: string;
      symbol: string;
      router: string;
      collateral: string;
      inventory: string;
    }> = [];

    for (const [chain, domain] of Object.entries(this.config.deployment.domains)) {
      const collateral = ERC20Test__factory.connect(domain.collateralToken, this.provider);
      const [routerBalance, inventoryBalance] = await Promise.all([
        collateral.balanceOf(domain.warpToken),
        collateral.balanceOf(this.signer.address),
      ]);

      routerBalances.push({
        routeId: this.routeId,
        chain,
        symbol: 'SIM',
        router: domain.warpToken,
        collateral: routerBalance.toString(),
        inventory: inventoryBalance.toString(),
      });
    }

    return {
      observedAt: Date.now(),
      routerBalances,
    };
  }

  private async inflight(source: 'rpc' | 'explorer' | 'hybrid'): Promise<{
    messages: Array<{
      messageId: string;
      type: 'user' | 'self';
      routeId: string;
      origin: string;
      destination: string;
      sourceRouter: string;
      destinationRouter: string;
      amount: string;
      status: 'in_progress';
      source: 'rpc' | 'explorer' | 'hybrid';
      txHash?: string;
    }>;
  }> {
    if (!this.config) {
      throw new Error('inflight called before initialization');
    }

    const messages: Array<{
      messageId: string;
      type: 'user' | 'self';
      routeId: string;
      origin: string;
      destination: string;
      sourceRouter: string;
      destinationRouter: string;
      amount: string;
      status: 'in_progress';
      source: 'rpc' | 'explorer' | 'hybrid';
      txHash?: string;
    }> = [];

    const transfers = await this.actionTracker.getInProgressTransfers();
    for (const transfer of transfers) {
      const origin = this.chainByDomain.get(Number(transfer.origin));
      const destination = this.chainByDomain.get(Number(transfer.destination));
      if (!origin || !destination) continue;
      const originDomain = this.config.deployment.domains[origin];
      const destinationDomain = this.config.deployment.domains[destination];
      messages.push({
        messageId: transfer.messageId,
        type: 'user',
        routeId: this.routeId,
        origin,
        destination,
        sourceRouter: originDomain.warpToken,
        destinationRouter: destinationDomain.warpToken,
        amount: transfer.amount.toString(),
        status: 'in_progress',
        source,
      });
    }

    const actions = await this.actionTracker.getInProgressActions();
    for (const action of actions) {
      const origin = this.chainByDomain.get(Number(action.origin));
      const destination = this.chainByDomain.get(Number(action.destination));
      if (!origin || !destination) continue;
      const originDomain = this.config.deployment.domains[origin];
      const destinationDomain = this.config.deployment.domains[destination];
      messages.push({
        messageId: action.messageId,
        type: 'self',
        routeId: this.routeId,
        origin,
        destination,
        sourceRouter: originDomain.warpToken,
        destinationRouter: destinationDomain.warpToken,
        amount: action.amount.toString(),
        status: 'in_progress',
        source,
        txHash: action.txHash,
      });
    }

    return { messages };
  }

  private plan(input: unknown): {
    summary: string;
    actions: PlannedRunnerAction[];
  } {
    if (!this.config) {
      throw new Error('plan called before initialization');
    }

    const wrapped = input as {
      context?: {
        observation?: {
          observedAt?: number;
          routerBalances?: Array<{ chain: string; collateral: string }>;
        };
        inflight?: InflightContextMessage[];
        priorContext?: { openActions?: unknown[] };
      };
    };
    const observation = wrapped.context?.observation;
    const inflight = wrapped.context?.inflight ?? [];
    const priorOpenActions = this.parsePriorOpenActions(
      wrapped.context?.priorContext?.openActions ?? [],
    );

    const blockedFingerprints = new Set(
      priorOpenActions.map((a) => a.actionFingerprint),
    );

    if (priorOpenActions.length > 0) {
      return {
        summary:
          'Skipping planning: waiting for previously submitted actions to reconcile',
        actions: [],
      };
    }

    const balances = new Map<string, bigint>();
    for (const [chain] of Object.entries(this.config.deployment.domains)) {
      balances.set(chain, 0n);
    }
    for (const entry of observation?.routerBalances ?? []) {
      balances.set(entry.chain, BigInt(entry.collateral));
    }

    const actions: PlannedRunnerAction[] = [];
    const plannedUserDeficitActions = this.planPendingTransferDeficits(
      actions,
      balances,
      inflight,
      blockedFingerprints,
    );

    if (!plannedUserDeficitActions) {
      if (this.config.strategyConfig.type === 'weighted') {
        this.planWeighted(actions, balances, blockedFingerprints);
      } else {
        this.planMinAmount(actions, balances, blockedFingerprints);
      }
    }

    return {
      summary: `Planned ${actions.length} rebalance action(s)`,
      actions,
    };
  }

  private parsePriorOpenActions(openActions: unknown[]): OpenActionContext[] {
    const parsed: OpenActionContext[] = [];

    for (const item of openActions) {
      const typed = item as Partial<OpenActionContext>;
      if (
        typeof typed?.actionFingerprint === 'string' &&
        typeof typed?.origin === 'string' &&
        typeof typed?.destination === 'string' &&
        typeof typed?.amount === 'string'
      ) {
        parsed.push({
          actionFingerprint: typed.actionFingerprint,
          origin: typed.origin,
          destination: typed.destination,
          amount: typed.amount,
        });
      }
    }

    return parsed;
  }

  private planPendingTransferDeficits(
    actions: PlannedRunnerAction[],
    balances: Map<string, bigint>,
    inflight: InflightContextMessage[],
    blockedFingerprints: Set<string>,
  ): boolean {
    if (!this.config) return false;

    const effectiveBalances = new Map(balances);
    const userFlows = new Map<string, bigint>();
    const selfInflightByDestination = new Map<string, bigint>();

    for (const message of inflight) {
      if (message.status !== 'in_progress') continue;
      const amount = BigInt(message.amount);
      if (amount <= 0n) continue;

      if (message.type === 'self') {
        effectiveBalances.set(
          message.origin,
          (effectiveBalances.get(message.origin) ?? 0n) - amount,
        );
        effectiveBalances.set(
          message.destination,
          (effectiveBalances.get(message.destination) ?? 0n) + amount,
        );
        selfInflightByDestination.set(
          message.destination,
          (selfInflightByDestination.get(message.destination) ?? 0n) + amount,
        );
      } else {
        const flowKey = `${message.origin}|${message.destination}`;
        userFlows.set(flowKey, (userFlows.get(flowKey) ?? 0n) + amount);
      }
    }

    if (userFlows.size === 0) {
      return false;
    }

    const hasSelfInflight = Array.from(selfInflightByDestination.values()).some(
      (amount) => amount > 0n,
    );
    if (hasSelfInflight) {
      return true;
    }

    // Net reciprocal user flows before creating deficit-repair actions.
    for (const [flowKey, amount] of Array.from(userFlows.entries())) {
      if (amount <= 0n) continue;
      const [origin, destination] = flowKey.split('|');
      const reverseKey = `${destination}|${origin}`;
      const reverseAmount = userFlows.get(reverseKey) ?? 0n;
      if (reverseAmount <= 0n) continue;
      const net = amount < reverseAmount ? amount : reverseAmount;
      userFlows.set(flowKey, amount - net);
      userFlows.set(reverseKey, reverseAmount - net);
    }

    const userPendingByDestination = new Map<string, bigint>();
    for (const [flowKey, amount] of userFlows.entries()) {
      if (amount <= 0n) continue;
      const [, destination] = flowKey.split('|');
      userPendingByDestination.set(
        destination,
        (userPendingByDestination.get(destination) ?? 0n) + amount,
      );
    }

    if (userPendingByDestination.size === 0) {
      return true;
    }

    for (const [destination, pendingAmount] of userPendingByDestination.entries()) {
      let shortfall =
        pendingAmount - (effectiveBalances.get(destination) ?? 0n);
      if (shortfall <= 0n) continue;

      const sourceCandidates = Array.from(effectiveBalances.entries())
        .filter(([chain]) => chain !== destination)
        .sort((a, b) => (a[1] > b[1] ? -1 : 1));

      for (const [origin] of sourceCandidates) {
        if (shortfall <= 0n) break;
        const sourceBalance = effectiveBalances.get(origin) ?? 0n;
        if (sourceBalance <= 0n) continue;
        const amount = sourceBalance < shortfall ? sourceBalance : shortfall;
        if (
          this.pushAction(
            actions,
            origin,
            destination,
            amount,
            'pending-user-deficit',
            blockedFingerprints,
          )
        ) {
          effectiveBalances.set(origin, sourceBalance - amount);
          effectiveBalances.set(
            destination,
            (effectiveBalances.get(destination) ?? 0n) + amount,
          );
          shortfall -= amount;
          selfInflightByDestination.set(
            destination,
            (selfInflightByDestination.get(destination) ?? 0n) + amount,
          );
          // Keep at most one new in-flight action per cycle.
          return true;
        }
      }
    }

    return true;
  }

  private planWeighted(
    actions: PlannedRunnerAction[],
    balances: Map<string, bigint>,
    blockedFingerprints: Set<string>,
  ): void {
    if (!this.config) return;

    const chains = Object.keys(this.config.strategyConfig.chains);
    let totalBalance = 0n;
    for (const chain of chains) {
      totalBalance += balances.get(chain) ?? 0n;
    }
    if (totalBalance <= 0n) return;

    let totalWeight = 0;
    for (const chain of chains) {
      const chainConfig = this.config.strategyConfig.chains[chain];
      const weight = chainConfig.weighted?.weight
        ? parseFloat(chainConfig.weighted.weight)
        : 1 / Math.max(chains.length, 1);
      totalWeight += weight;
    }

    const excess: Array<{ chain: string; amount: bigint }> = [];
    const deficit: Array<{ chain: string; amount: bigint }> = [];

    for (const chain of chains) {
      const chainConfig = this.config.strategyConfig.chains[chain];
      const weight = chainConfig.weighted?.weight
        ? parseFloat(chainConfig.weighted.weight)
        : 1 / Math.max(chains.length, 1);
      const tolerance = chainConfig.weighted?.tolerance
        ? parseFloat(chainConfig.weighted.tolerance)
        : 0.1;

      const scaledWeight = BigInt(Math.floor(weight * 10000));
      const scaledTotalWeight = BigInt(Math.floor(totalWeight * 10000));
      if (scaledTotalWeight === 0n) continue;

      const targetBalance = (totalBalance * scaledWeight) / scaledTotalWeight;
      const currentBalance = balances.get(chain) ?? 0n;

      const minBalance =
        (targetBalance * BigInt(Math.floor((1 - tolerance) * 10000))) / 10000n;
      const maxBalance =
        (targetBalance * BigInt(Math.floor((1 + tolerance) * 10000))) / 10000n;

      if (currentBalance > maxBalance) {
        excess.push({ chain, amount: currentBalance - targetBalance });
      } else if (currentBalance < minBalance) {
        deficit.push({ chain, amount: targetBalance - currentBalance });
      }
    }

    for (const from of excess) {
      for (const to of deficit) {
        if (from.amount <= 0n || to.amount <= 0n) continue;
        const amount = from.amount < to.amount ? from.amount : to.amount;
        if (
          this.pushAction(
            actions,
            from.chain,
            to.chain,
            amount,
            'weighted',
            blockedFingerprints,
          )
        ) {
          from.amount -= amount;
          to.amount -= amount;
        }
      }
    }
  }

  private planMinAmount(
    actions: PlannedRunnerAction[],
    balances: Map<string, bigint>,
    blockedFingerprints: Set<string>,
  ): void {
    if (!this.config) return;

    const belowMin: Array<{ chain: string; deficit: bigint }> = [];
    const aboveTarget: Array<{ chain: string; excess: bigint }> = [];

    for (const [chain, chainConfig] of Object.entries(this.config.strategyConfig.chains)) {
      const minAmountConfig = chainConfig.minAmount;
      if (!minAmountConfig) continue;

      const current = balances.get(chain) ?? 0n;
      const min = BigInt(minAmountConfig.min);
      const target = BigInt(minAmountConfig.target);

      if (current < min) {
        belowMin.push({ chain, deficit: target - current });
      } else if (current > target * 2n) {
        aboveTarget.push({ chain, excess: current - target });
      }
    }

    for (const to of belowMin) {
      for (const from of aboveTarget) {
        if (to.deficit <= 0n || from.excess <= 0n) continue;
        const amount = to.deficit < from.excess ? to.deficit : from.excess;
        if (
          this.pushAction(
            actions,
            from.chain,
            to.chain,
            amount,
            'minAmount',
            blockedFingerprints,
          )
        ) {
          to.deficit -= amount;
          from.excess -= amount;
        }
      }
    }
  }

  private pushAction(
    actions: PlannedRunnerAction[],
    origin: string,
    destination: string,
    amount: bigint,
    reason: string,
    blockedFingerprints: Set<string>,
  ): boolean {
    if (!this.config || amount <= 0n) return false;
    const originDomain = this.config.deployment.domains[origin];
    const destinationDomain = this.config.deployment.domains[destination];
    if (!originDomain || !destinationDomain || origin === destination) return false;

    const fingerprint = [
      this.routeId,
      origin,
      destination,
      originDomain.warpToken.toLowerCase(),
      destinationDomain.warpToken.toLowerCase(),
      amount.toString(),
      'movableCollateral',
    ].join('|');

    if (blockedFingerprints.has(fingerprint)) {
      return false;
    }
    blockedFingerprints.add(fingerprint);

    actions.push({
      actionFingerprint: fingerprint,
      executionType: 'movableCollateral',
      routeId: this.routeId,
      origin,
      destination,
      sourceRouter: originDomain.warpToken,
      destinationRouter: destinationDomain.warpToken,
      amount: amount.toString(),
      reason,
    });
    return true;
  }

  private async executeRebalance(input: unknown): Promise<{
    success: boolean;
    txHash?: string;
    messageId?: string;
    error?: string;
  }> {
    if (!this.config || !this.signer) {
      throw new Error('execute called before initialization');
    }

    const typed = input as {
      action?: {
        origin: string;
        destination: string;
        amount: string;
      };
    };
    const action = typed.action;
    if (!action) {
      return { success: false, error: 'missing action payload' };
    }

    const fromDomain = this.config.deployment.domains[action.origin];
    const toDomain = this.config.deployment.domains[action.destination];
    if (!fromDomain || !toDomain) {
      return { success: false, error: 'invalid origin/destination domain' };
    }

    const amount = BigInt(action.amount);
    if (amount <= 0n) {
      return { success: false, error: 'invalid action amount' };
    }

    try {
      const warpToken = HypERC20Collateral__factory.connect(
        fromDomain.warpToken,
        this.signer,
      );
      const tx = await warpToken.rebalance(
        toDomain.domainId,
        amount,
        fromDomain.bridge,
      );
      await tx.wait();

      const intent = await this.actionTracker.createRebalanceIntent({
        origin: fromDomain.domainId,
        destination: toDomain.domainId,
        amount,
        bridge: fromDomain.bridge,
        priority: 1,
        strategyType: this.name,
      });
      await this.actionTracker.createRebalanceAction({
        intentId: intent.id,
        origin: fromDomain.domainId,
        destination: toDomain.domainId,
        amount,
        messageId: tx.hash,
        txHash: tx.hash,
      });

      this.emit('rebalance', {
        type: 'rebalance_completed',
        timestamp: Date.now(),
        origin: action.origin,
        destination: action.destination,
        amount,
      } satisfies RebalancerEvent);

      return { success: true, txHash: tx.hash, messageId: tx.hash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('rebalance', {
        type: 'rebalance_failed',
        timestamp: Date.now(),
        origin: action.origin,
        destination: action.destination,
        amount,
        error: message,
      } satisfies RebalancerEvent);
      return { success: false, error: message };
    }
  }

  private async reconcile(input: unknown): Promise<{
    deliveredActionFingerprints: string[];
    inProgressRebalanceActions: number;
  }> {
    if (!this.config) {
      throw new Error('reconcile called before initialization');
    }

    const typed = input as {
      plannerOutput?: {
        actions?: Array<{
          actionFingerprint: string;
          origin: string;
          destination: string;
          amount: string;
        }>;
      };
      priorContext?: {
        openActions?: unknown[];
      };
    };
    const plannedActions = typed.plannerOutput?.actions ?? [];
    const priorOpenActions = this.parsePriorOpenActions(
      typed.priorContext?.openActions ?? [],
    );
    const inProgress = await this.actionTracker.getInProgressActions();

    const inProgressKeys = new Set(
      inProgress.map((action) =>
        `${action.origin}|${action.destination}|${action.amount.toString()}`,
      ),
    );

    const candidates = new Map<
      string,
      { actionFingerprint: string; origin: string; destination: string; amount: string }
    >();
    for (const action of priorOpenActions) {
      candidates.set(action.actionFingerprint, action);
    }
    for (const action of plannedActions) {
      candidates.set(action.actionFingerprint, action);
    }

    const deliveredActionFingerprints: string[] = [];
    for (const action of candidates.values()) {
      const fromDomain = this.config.deployment.domains[action.origin];
      const toDomain = this.config.deployment.domains[action.destination];
      if (!fromDomain || !toDomain) continue;
      const key = `${fromDomain.domainId}|${toDomain.domainId}|${action.amount}`;
      if (!inProgressKeys.has(key)) {
        deliveredActionFingerprints.push(action.actionFingerprint);
      }
    }

    return {
      deliveredActionFingerprints,
      inProgressRebalanceActions: inProgress.length,
    };
  }
}
