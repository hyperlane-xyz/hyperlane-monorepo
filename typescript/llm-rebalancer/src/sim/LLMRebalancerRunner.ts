/**
 * LLMRebalancerRunner — IRebalancerRunner implementation for rebalancer-sim.
 *
 * Creates a temp working directory, copies skills, writes config + AGENTS.md,
 * initializes SQLite, and runs Pi agent cycles on a polling loop.
 *
 * No MockActionTracker needed — the controller auto-tracks rebalances
 * from Dispatch events.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

import { pino } from 'pino';

import type {
  IRebalancerRunner,
  RebalancerEvent,
  RebalancerSimConfig,
} from '@hyperlane-xyz/rebalancer-sim';

import type {
  ChainConfig,
  RebalancerAgentConfig,
  StrategyDescription,
} from '../config.js';
import type { CreateSessionOptions } from '../agent.js';
import { runRebalancerCycle } from '../agent.js';
import { buildAgentsPrompt } from '../prompt-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  private pollingTimer?: ReturnType<typeof setTimeout>;
  private sessionOpts?: CreateSessionOptions;

  /** Model provider (default: 'anthropic') */
  private provider: string;
  /** Model name (default: 'claude-sonnet-4-5') */
  private model: string;

  constructor(opts?: { provider?: string; model?: string }) {
    super();
    this.provider = opts?.provider ?? 'anthropic';
    this.model = opts?.model ?? 'claude-sonnet-4-5';
  }

  async initialize(config: RebalancerSimConfig): Promise<void> {
    await cleanupLLMRebalancer();

    this.config = config;

    // Create temp working directory
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-rebalancer-'));
    logger.info({ workDir: this.workDir }, 'Created temp work dir');

    // Copy skills into .pi/skills/
    const skillsSrc = path.resolve(__dirname, '..', '..', 'skills');
    const skillsDest = path.join(this.workDir, '.pi', 'skills');
    fs.mkdirSync(skillsDest, { recursive: true });
    this.copyDirSync(skillsSrc, skillsDest);

    // Copy schema
    const schemaSrc = path.resolve(__dirname, '..', '..', 'schema');
    const schemaDest = path.join(this.workDir, 'schema');
    fs.mkdirSync(schemaDest, { recursive: true });
    this.copyDirSync(schemaSrc, schemaDest);

    // Build agent config from deployment
    const agentConfig = this.buildAgentConfig(config);
    fs.writeFileSync(
      path.join(this.workDir, 'rebalancer-config.json'),
      JSON.stringify(agentConfig, null, 2),
    );

    // Build strategy from sim config
    const strategy = this.buildStrategy(config);

    // Build AGENTS.md prompt
    const agentsPrompt = buildAgentsPrompt(agentConfig, strategy);

    // Initialize SQLite action log
    const schemaPath = path.join(this.workDir, 'schema', 'action-log.sql');
    const dbPath = path.join(this.workDir, 'action-log.db');
    execSync(`sqlite3 "${dbPath}" < "${schemaPath}"`);

    this.sessionOpts = {
      workDir: this.workDir,
      provider: this.provider,
      model: this.model,
      agentsPrompt,
    };
  }

  async start(): Promise<void> {
    if (!this.config || !this.sessionOpts) {
      throw new Error('LLMRebalancer not initialized');
    }
    if (this.running) return;

    this.running = true;
    currentRunner = this;
    logger.info('Starting LLM rebalancer daemon');

    this.scheduleNextCycle();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }

    // Wait for in-progress cycle
    if (this.cycleInProgress) {
      const maxWait = 120_000;
      const start = Date.now();
      while (this.cycleInProgress && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 500));
      }
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
    this.sessionOpts = undefined;
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

  private scheduleNextCycle(): void {
    if (!this.running || !this.config) return;

    this.pollingTimer = setTimeout(async () => {
      if (!this.running || this.cycleInProgress) {
        this.scheduleNextCycle();
        return;
      }

      this.cycleInProgress = true;

      try {
        await runRebalancerCycle(this.sessionOpts!);
        this.emit('rebalance', {
          type: 'cycle_completed',
          timestamp: Date.now(),
        } satisfies RebalancerEvent);
      } catch (error) {
        logger.error({ error }, 'Rebalancer cycle failed');
        this.emit('rebalance', {
          type: 'rebalance_failed',
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        } satisfies RebalancerEvent);
      } finally {
        this.cycleInProgress = false;
        this.scheduleNextCycle();
      }
    }, this.config.pollingFrequency);
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
