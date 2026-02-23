#!/usr/bin/env tsx
/**
 * Production entry point for the LLM rebalancer.
 *
 * Usage:
 *   REBALANCER_KEY=0x... ANTHROPIC_API_KEY=sk-... tsx scripts/run.ts config.json
 */

import * as fs from 'fs';
import * as path from 'path';

import { runRebalancerCycle } from '../src/agent.js';
import type {
  LLMRebalancerOptions,
  RebalancerAgentConfig,
} from '../src/config.js';
import { InMemoryContextStore } from '../src/context-store.js';
import { buildAgentsPrompt } from '../src/prompt-builder.js';
import { buildCustomTools } from '../src/tools/index.js';

interface ConfigFile {
  chains: RebalancerAgentConfig['chains'];
  rebalancerAddress: string;
  strategy: LLMRebalancerOptions['strategy'];
  pollingIntervalMs?: number;
  model?: string;
  provider?: string;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: tsx scripts/run.ts <config.json>');
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(configPath), 'utf-8');
  const config: ConfigFile = JSON.parse(raw);

  const rebalancerKey = process.env.REBALANCER_KEY;
  if (!rebalancerKey) {
    console.error('REBALANCER_KEY env var required');
    process.exit(1);
  }

  const agentConfig: RebalancerAgentConfig = {
    chains: config.chains,
    rebalancerAddress: config.rebalancerAddress,
    rebalancerKey,
  };

  const contextStore = new InMemoryContextStore();
  const routeId = 'default';

  // Set up working directory
  const workDir = process.cwd();

  // Write config (sans key) for the agent to read
  const configForFile = {
    chains: agentConfig.chains,
    rebalancerAddress: agentConfig.rebalancerAddress,
  };
  fs.writeFileSync(
    path.join(workDir, 'rebalancer-config.json'),
    JSON.stringify(configForFile, null, 2),
  );

  const customTools = buildCustomTools(agentConfig, contextStore, routeId);
  const pollingIntervalMs = config.pollingIntervalMs ?? 30_000;

  console.log(
    `LLM Rebalancer starting (polling every ${pollingIntervalMs / 1000}s)`,
  );

  async function cycle() {
    const previousContext = await contextStore.get(routeId);
    let parsedContext: string | null = null;
    if (previousContext) {
      try {
        const parsed = JSON.parse(previousContext);
        parsedContext = parsed.summary ?? previousContext;
      } catch {
        parsedContext = previousContext;
      }
    }

    const agentsPrompt = buildAgentsPrompt(
      agentConfig,
      config.strategy,
      parsedContext,
    );

    await runRebalancerCycle({
      workDir,
      provider: config.provider,
      model: config.model,
      agentsPrompt,
      customTools,
    });
  }

  // Run first cycle immediately
  await cycle();

  // Then poll
  setInterval(async () => {
    try {
      await cycle();
    } catch (error) {
      console.error('Cycle failed:', error);
    }
  }, pollingIntervalMs);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
