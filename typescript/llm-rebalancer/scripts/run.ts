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
import { buildAgentsPrompt } from '../src/prompt-builder.js';

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

  const agentConfig: RebalancerAgentConfig = {
    chains: config.chains,
    rebalancerAddress: config.rebalancerAddress,
  };

  const agentsPrompt = buildAgentsPrompt(agentConfig, config.strategy);

  // Set up working directory
  const workDir = process.cwd();

  // Write config for the agent to read
  fs.writeFileSync(
    path.join(workDir, 'rebalancer-config.json'),
    JSON.stringify(agentConfig, null, 2),
  );

  const pollingIntervalMs = config.pollingIntervalMs ?? 30_000;

  console.log(
    `LLM Rebalancer starting (polling every ${pollingIntervalMs / 1000}s)`,
  );

  const sessionOpts = {
    workDir,
    provider: config.provider,
    model: config.model,
    agentsPrompt,
    env: {
      REBALANCER_KEY: process.env.REBALANCER_KEY!,
      REBALANCER_ADDRESS: config.rebalancerAddress,
    },
  };

  // Run first cycle immediately
  await runRebalancerCycle(sessionOpts);

  // Then poll
  setInterval(async () => {
    try {
      await runRebalancerCycle(sessionOpts);
    } catch (error) {
      console.error('Cycle failed:', error);
    }
  }, pollingIntervalMs);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
