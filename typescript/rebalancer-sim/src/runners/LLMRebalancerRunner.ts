/**
 * LLMRebalancerRunner — IRebalancerRunner implementation using an LLM agent.
 *
 * Creates a temp working directory, copies skills, writes config + AGENTS.md,
 * and runs Pi agent cycles in a while loop with context persistence.
 *
 * No MockActionTracker needed — the controller auto-tracks rebalances
 * from Dispatch events.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

import { pino } from 'pino';

import {
  InMemoryContextStore,
  buildAgentsPrompt,
  buildCustomTools,
  runRebalancerCycle,
} from '@hyperlane-xyz/llm-rebalancer';
import type {
  ChainConfig,
  ContextStore,
  CreateSessionOptions,
  CycleResult,
  RebalancerAgentConfig,
  StrategyDescription,
} from '@hyperlane-xyz/llm-rebalancer';

import type {
  IRebalancerRunner,
  RebalancerEvent,
  RebalancerSimConfig,
} from '../types.js';

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

  /** Model provider (default: 'anthropic') */
  private provider: string;
  /** Model name (default: 'claude-sonnet-4-5') */
  private model: string;

  /** Adaptive polling config */
  private adaptivePolling?: { shortIntervalMs: number; longIntervalMs: number };

  constructor(opts?: {
    provider?: string;
    model?: string;
    adaptivePolling?: { shortIntervalMs: number; longIntervalMs: number };
  }) {
    super();
    this.provider = opts?.provider ?? 'anthropic';
    this.model = opts?.model ?? 'claude-sonnet-4-5';
    this.adaptivePolling = opts?.adaptivePolling;
    this.contextStore = new InMemoryContextStore();
    this.routeId = 'default';
  }

  async initialize(config: RebalancerSimConfig): Promise<void> {
    await cleanupLLMRebalancer();

    this.config = config;

    // Create temp working directory
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-rebalancer-'));
    logger.info({ workDir: this.workDir }, 'Created temp work dir');

    // Copy skills into .pi/skills/
    const skillsSrc = this.findSkillsDir();
    const skillsDest = path.join(this.workDir, '.pi', 'skills');
    fs.mkdirSync(skillsDest, { recursive: true });
    this.copyDirSync(skillsSrc, skillsDest);

    // Build agent config from deployment
    this.agentConfig = this.buildAgentConfig(config);

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

    // Build custom tools with agent config closure (includes rebalancerKey)
    const customTools = buildCustomTools(
      this.agentConfig,
      this.contextStore,
      this.routeId,
    );

    this.baseSessionOpts = {
      workDir: this.workDir,
      provider: this.provider,
      model: this.model,
      customTools,
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
    logger.info('Starting LLM rebalancer daemon');

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

    // Cleanup temp dir
    if (this.workDir && fs.existsSync(this.workDir)) {
      try {
        fs.rmSync(this.workDir, { recursive: true, force: true });
        logger.info({ workDir: this.workDir }, 'Cleaned up temp dir');
      } catch {
        // Best effort
      }
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

  // No action tracker — controller auto-tracks from Dispatch events
  getActionTracker(): undefined {
    return undefined;
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
        const sessionOpts = await this.buildSessionOptsForCycle();
        const result = await runRebalancerCycle(sessionOpts);
        this.lastCycleStatus = result.status;
      } catch (error) {
        logger.error({ error }, 'Rebalancer cycle failed');
        this.lastCycleStatus = 'unknown';
        this.emit('rebalance', {
          type: 'rebalance_failed',
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        } satisfies RebalancerEvent);
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
      return { type: 'weighted', chains };
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
      return { type: 'minAmount', chains };
    }

    // Fallback: generate prose from whatever we have
    return {
      type: 'prose',
      text: `Maintain balanced collateral distribution across all chains. Strategy type: ${strategyConfig.type}.`,
    };
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
