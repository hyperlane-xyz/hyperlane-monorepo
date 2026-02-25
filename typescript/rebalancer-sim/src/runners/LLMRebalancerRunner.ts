/**
 * LLMRebalancerRunner — IRebalancerRunner implementation using an LLM agent.
 *
 * Creates a temp working directory, copies skills, writes config + AGENTS.md,
 * and runs Pi agent cycles in a while loop with context persistence.
 *
 * Uses MockActionTracker to expose inflight user transfers via get_pending_transfers tool.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

import { pino } from 'pino';

import {
  InMemoryContextStore,
  RebalancerAgent,
  SqliteContextStore,
  buildAgentsPrompt,
  buildCustomTools,
} from '@hyperlane-xyz/llm-rebalancer';
import type {
  ChainConfig,
  ContextStore,
  CreateSessionOptions,
  CycleResult,
  PendingTransfer,
  PendingTransferProvider,
  RebalancerAgentConfig,
  StrategyDescription,
} from '@hyperlane-xyz/llm-rebalancer';

import type { KPICollector } from '../KPICollector.js';
import { buildMockLifiSwapTool } from './rebalancing-tools.js';

import type {
  IRebalancerRunner,
  RebalancerEvent,
  RebalancerSimConfig,
} from '../types.js';
import { MockActionTracker } from './MockActionTracker.js';

const logger = pino({ name: 'LLMRebalancerRunner', level: 'info' });

// Track current instance for cleanup
let currentRunner: LLMRebalancerRunner | null = null;

export async function cleanupLLMRebalancer(): Promise<void> {
  if (currentRunner) {
    const runner = currentRunner;
    currentRunner = null;
    try {
      await runner.stop();
    } catch {
      // Ignore errors
    }
  }
}

export class LLMRebalancerRunner
  extends EventEmitter
  implements IRebalancerRunner
{
  readonly name = 'LLMRebalancer';

  private config?: RebalancerSimConfig;
  private workDir?: string;
  private running = false;
  private cycleInProgress = false;
  private loopPromise?: Promise<void>;
  private abortController?: AbortController;
  private baseSessionOpts?: Omit<CreateSessionOptions, 'agentsPrompt'>;
  private agentConfig?: RebalancerAgentConfig;
  private strategy?: StrategyDescription;
  private contextStore: ContextStore;
  private routeId: string;
  private lastCycleStatus: CycleResult['status'] = 'unknown';
  private agent?: RebalancerAgent;
  private actionTracker = new MockActionTracker();

  /** Model provider (default: 'anthropic') */
  private provider: string;
  /** Model name (default: 'claude-haiku-4-5') */
  private model: string;

  /** Adaptive polling config */
  private adaptivePolling?: { shortIntervalMs: number; longIntervalMs: number };

  /** KPI collector for mock swap tool tracking (set by SimulationEngine) */
  private kpiCollector?: KPICollector;

  /** Cycle guardrail options */
  private cycleTimeoutMs?: number;
  private maxToolCallsPerCycle?: number;

  constructor(opts?: {
    provider?: string;
    model?: string;
    adaptivePolling?: { shortIntervalMs: number; longIntervalMs: number };
    contextDbPath?: string;
    cycleTimeoutMs?: number;
    maxToolCallsPerCycle?: number;
  }) {
    super();
    this.provider = opts?.provider ?? 'opencode';
    this.model = opts?.model ?? 'gpt-5.1-codex-mini';
    this.adaptivePolling = opts?.adaptivePolling;
    this.cycleTimeoutMs = opts?.cycleTimeoutMs;
    this.maxToolCallsPerCycle = opts?.maxToolCallsPerCycle;
    this.contextStore = opts?.contextDbPath
      ? new SqliteContextStore(opts.contextDbPath)
      : new InMemoryContextStore();
    this.routeId = 'default';
  }

  async initialize(config: RebalancerSimConfig): Promise<void> {
    await cleanupLLMRebalancer();

    this.config = config;

    // Clear stale context from previous runs
    await this.contextStore.clear(this.routeId);

    // Create temp working directory
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-rebalancer-'));
    logger.info({ workDir: this.workDir }, 'Created temp work dir');

    // Copy skills into .pi/skills/
    const skillsSrc = this.findSkillsDir();
    const skillsDest = path.join(this.workDir, '.pi', 'skills');
    fs.mkdirSync(skillsDest, { recursive: true });
    this.copyDirSync(skillsSrc, skillsDest);

    // Copy sim-only skills (e.g., rebalance-mock-bridge)
    const simSkillsSrc = this.findSimSkillsDir();
    if (simSkillsSrc && fs.existsSync(simSkillsSrc)) {
      this.copyDirSync(simSkillsSrc, skillsDest);
    }

    // Build agent config from deployment
    this.agentConfig = this.buildAgentConfig(config);

    // Import rebalancer key into foundry keystore (both local and default location)
    const keystoreDir = path.join(this.workDir, 'keystore');
    fs.mkdirSync(keystoreDir, { recursive: true });
    const { execSync } = await import('child_process');
    execSync(
      `cast wallet import rebalancer --private-key ${this.agentConfig.rebalancerKey} --keystore-dir ${keystoreDir} --unsafe-password ''`,
      { stdio: 'pipe' },
    );
    // Also copy to default foundry keystore dir so `--account rebalancer` works without --keystore-dir
    const defaultKeystoreDir = path.join(os.homedir(), '.foundry', 'keystores');
    fs.mkdirSync(defaultKeystoreDir, { recursive: true });
    fs.copyFileSync(
      path.join(keystoreDir, 'rebalancer'),
      path.join(defaultKeystoreDir, 'rebalancer'),
    );
    logger.info('Imported rebalancer key into foundry keystore');

    // Write config JSON (sans rebalancerKey for agent reference)
    const configForFile = {
      chains: this.agentConfig.chains,
      rebalancerAddress: this.agentConfig.rebalancerAddress,
    };
    fs.writeFileSync(
      path.join(this.workDir, 'rebalancer-config.json'),
      JSON.stringify(configForFile, null, 2),
    );

    // Build strategy from sim config
    this.strategy = this.buildStrategy(config);

    // Build domain → chainName lookup for the adapter
    const domainToChain: Record<number, string> = {};
    for (const [name, chain] of Object.entries(this.agentConfig.chains)) {
      domainToChain[chain.domainId] = name;
    }

    // Adapter: wraps MockActionTracker as PendingTransferProvider
    const tracker = this.actionTracker;
    const pendingTransferProvider: PendingTransferProvider = {
      async getPendingTransfers(): Promise<PendingTransfer[]> {
        const transfers = await tracker.getInProgressTransfers();
        return transfers.map((t) => {
          const meta = tracker.getTransferMeta(t.id);
          return {
            messageId: t.messageId,
            origin: domainToChain[t.origin] ?? String(t.origin),
            destination: domainToChain[t.destination] ?? String(t.destination),
            amount: t.amount.toString(),
            sourceAsset: meta?.sourceAsset,
            destinationAsset: meta?.destinationAsset,
            targetRouter: meta?.targetRouter,
          };
        });
      },
    };

    // Build custom tools with agent config closure (includes rebalancerKey)
    const customTools = buildCustomTools(
      this.agentConfig,
      this.contextStore,
      this.routeId,
      pendingTransferProvider,
    );

    // Register mock_lifi_swap for multi-asset deployments
    const isMultiAsset = Object.values(this.agentConfig.chains).some(
      (c) => c.assets,
    );
    if (isMultiAsset) {
      customTools.push(
        buildMockLifiSwapTool(this.agentConfig, this.kpiCollector),
      );
    }

    // Overwrite skill files with tool-redirect stubs so the LLM uses
    // tools instead of constructing raw cast transactions
    this.overwriteSkillStubs(skillsDest);

    this.baseSessionOpts = {
      workDir: this.workDir,
      provider: this.provider,
      model: this.model,
      customTools,
      cycleTimeoutMs: this.cycleTimeoutMs,
      maxToolCallsPerCycle: this.maxToolCallsPerCycle,
    };
  }

  async start(): Promise<void> {
    if (!this.config || !this.baseSessionOpts) {
      throw new Error('LLMRebalancer not initialized');
    }
    if (this.running) return;

    this.running = true;
    this.abortController = new AbortController();
    currentRunner = this;

    // Create persistent agent session (reused across all cycles)
    const sessionOpts = await this.buildSessionOptsForCycle();
    this.agent = await RebalancerAgent.create(sessionOpts);
    logger.info('Starting LLM rebalancer daemon (persistent session)');

    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;

    // Interrupt any pending sleep
    this.abortController?.abort();
    this.abortController = undefined;

    // Wait for the loop to finish
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = undefined;
    }

    // Dispose persistent agent session
    this.agent?.dispose();
    this.agent = undefined;

    // Cleanup temp dir
    if (this.workDir && fs.existsSync(this.workDir)) {
      try {
        fs.rmSync(this.workDir, { recursive: true, force: true });
        logger.info({ workDir: this.workDir }, 'Cleaned up temp dir');
      } catch {
        // Best effort
      }
    }

    // Close SQLite if used
    if ('close' in this.contextStore) {
      (this.contextStore as { close(): void }).close();
    }

    this.workDir = undefined;
    this.baseSessionOpts = undefined;
    currentRunner = null;
  }

  isActive(): boolean {
    return this.running && this.cycleInProgress;
  }

  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (this.cycleInProgress && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  on(event: 'rebalance', listener: (e: RebalancerEvent) => void): this {
    return super.on(event, listener);
  }

  getActionTracker(): MockActionTracker {
    return this.actionTracker;
  }

  setKpiCollector(collector: KPICollector): void {
    this.kpiCollector = collector;
  }

  // --- Private ---

  private getPollingInterval(): number {
    if (!this.adaptivePolling) {
      return this.config!.pollingFrequency;
    }
    if (this.lastCycleStatus === 'balanced') {
      return this.adaptivePolling.longIntervalMs;
    }
    // pending or unknown → short interval
    return this.adaptivePolling.shortIntervalMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      await this.sleep(this.getPollingInterval());
      if (!this.running) break;

      this.cycleInProgress = true;
      try {
        const result = await this.agent!.runCycle();
        this.lastCycleStatus = result.status;
      } catch (error) {
        logger.error({ error }, 'Cycle failed, recreating session');
        this.lastCycleStatus = 'unknown';
        this.emit('rebalance', {
          type: 'rebalance_failed',
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        } satisfies RebalancerEvent);

        // Recreate agent on failure (session may be corrupted)
        try {
          this.agent?.dispose();
          const sessionOpts = await this.buildSessionOptsForCycle();
          this.agent = await RebalancerAgent.create(sessionOpts);
        } catch (recreateError) {
          logger.error({ error: recreateError }, 'Failed to recreate session');
        }
      } finally {
        this.cycleInProgress = false;
      }
    }
  }

  private async buildSessionOptsForCycle(): Promise<CreateSessionOptions> {
    // Fetch previous context and inject into prompt
    const rawContext = await this.contextStore.get(this.routeId);
    let previousContext: string | null = null;
    if (rawContext) {
      try {
        const parsed = JSON.parse(rawContext);
        previousContext = parsed.summary ?? rawContext;
      } catch {
        previousContext = rawContext;
      }
    }

    const agentsPrompt = buildAgentsPrompt(
      this.agentConfig!,
      this.strategy!,
      previousContext,
    );

    return {
      ...this.baseSessionOpts!,
      agentsPrompt,
    };
  }

  private findSimSkillsDir(): string | null {
    // Find sim-only skills directory from rebalancer-sim package
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const candidate = path.resolve(thisDir, '..', '..', 'skills');
    if (fs.existsSync(candidate)) return candidate;
    return null;
  }

  private findSkillsDir(): string {
    // Find skills directory from llm-rebalancer package
    try {
      const require = createRequire(import.meta.url);
      const llmPkg =
        require.resolve('@hyperlane-xyz/llm-rebalancer/package.json');
      return path.join(path.dirname(llmPkg), 'skills');
    } catch {
      // Fallback: relative path from monorepo layout
      const thisDir = path.dirname(new URL(import.meta.url).pathname);
      return path.resolve(
        thisDir,
        '..',
        '..',
        '..',
        'llm-rebalancer',
        'skills',
      );
    }
  }

  private buildAgentConfig(config: RebalancerSimConfig): RebalancerAgentConfig {
    const chains: Record<string, ChainConfig> = {};

    for (const [chainName, domain] of Object.entries(
      config.deployment.domains,
    )) {
      chains[chainName] = {
        chainName,
        domainId: domain.domainId,
        rpcUrl: config.deployment.anvilRpc,
        mailbox: domain.mailbox,
        warpToken: domain.warpToken,
        collateralToken: domain.collateralToken,
        bridge: domain.bridge,
        assets: domain.assets
          ? Object.fromEntries(
              Object.entries(domain.assets).map(([symbol, asset]) => [
                symbol,
                {
                  symbol,
                  decimals: asset.decimals,
                  warpToken: asset.warpToken,
                  collateralToken: asset.collateralToken,
                  bridge: asset.bridge,
                },
              ]),
            )
          : undefined,
      };
    }

    return {
      chains,
      rebalancerAddress: config.deployment.rebalancer,
      rebalancerKey: config.deployment.rebalancerKey,
    };
  }

  private buildStrategy(config: RebalancerSimConfig): StrategyDescription {
    const { strategyConfig } = config;

    if (strategyConfig.type === 'weighted') {
      const chains: Record<string, { weight: number; tolerance: number }> = {};
      for (const [chain, chainConfig] of Object.entries(
        strategyConfig.chains,
      )) {
        if (chainConfig.weighted) {
          chains[chain] = {
            weight: parseFloat(chainConfig.weighted.weight),
            tolerance: parseFloat(chainConfig.weighted.tolerance),
          };
        }
      }
      return {
        type: 'weighted',
        chains,
        routeHints: strategyConfig.routeHints,
        policyProse: strategyConfig.policyProse,
      };
    }

    if (strategyConfig.type === 'minAmount') {
      const chains: Record<
        string,
        { min: string; target: string; amountType: 'absolute' | 'relative' }
      > = {};
      for (const [chain, chainConfig] of Object.entries(
        strategyConfig.chains,
      )) {
        if (chainConfig.minAmount) {
          chains[chain] = {
            min: chainConfig.minAmount.min,
            target: chainConfig.minAmount.target,
            amountType: chainConfig.minAmount.type,
          };
        }
      }
      return {
        type: 'minAmount',
        chains,
        routeHints: strategyConfig.routeHints,
        policyProse: strategyConfig.policyProse,
      };
    }

    // Fallback: generate prose from whatever we have
    return {
      type: 'prose',
      text: `Maintain balanced collateral distribution across all chains. Strategy type: ${strategyConfig.type}.`,
      routeHints: strategyConfig.routeHints,
      policyProse: strategyConfig.policyProse,
    };
  }

  /**
   * Overwrite skill files with stubs that redirect the LLM to use
   * the structured tools instead of constructing raw transactions.
   */
  private overwriteSkillStubs(skillsDest: string): void {
    const stubs: Record<string, string> = {
      'rebalance-mock-bridge': [
        '---',
        'name: rebalance-mock-bridge',
        '---',
        '# Disabled — use `rebalance_collateral` tool',
        '',
        'Call the `rebalance_collateral` tool with `source` and `destination` node IDs and `amount`.',
        'The tool handles the on-chain transaction. Do NOT use `cast send` for rebalancing.',
      ].join('\n'),
      'inventory-deposit': [
        '---',
        'name: inventory-deposit',
        '---',
        '# Disabled — use `supply_collateral` tool',
        '',
        'Call the `supply_collateral` tool with `source` (where your wallet inventory is),',
        '`destination` (which router to supply), and `amount`.',
        'The tool handles approvals, encoding, and bridge calls. Do NOT use `cast send`.',
      ].join('\n'),
    };

    for (const [skillName, content] of Object.entries(stubs)) {
      const skillDir = path.join(skillsDest, skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    }
  }

  private copyDirSync(src: string, dest: string): void {
    if (!fs.existsSync(src)) return;

    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        this.copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
