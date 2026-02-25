#!/usr/bin/env tsx
/**
 * Production entry point for the LLM rebalancer.
 *
 * Usage:
 *   REBALANCER_KEY=0x... OPENCODE_API_KEY=... tsx scripts/run.ts config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { RebalancerAgent } from '../src/agent.js';
import type {
  LLMRebalancerOptions,
  RebalancerAgentConfig,
} from '../src/config.js';
import { SqliteContextStore } from '../src/context-store.js';
import {
  ExplorerPendingTransferProvider,
  type ExplorerClientLike,
} from '../src/explorer-pending-transfers.js';
import type { PendingTransferProvider } from '../src/pending-transfers.js';
import { buildAgentsPrompt } from '../src/prompt-builder.js';
import { buildCustomTools } from '../src/tools/index.js';

interface ConfigFile {
  chains: RebalancerAgentConfig['chains'];
  rebalancerAddress: string;
  strategy: LLMRebalancerOptions['strategy'];
  pollingIntervalMs?: number;
  model?: string;
  provider?: string;
  dbPath?: string;
  explorerUrl?: string;
}

/** Minimal GraphQL client satisfying ExplorerClientLike */
function createExplorerClient(baseUrl: string): ExplorerClientLike {
  const toBytea = (addr: string) => addr.replace(/^0x/i, '\\x').toLowerCase();
  const normalizeHex = (hex: string) =>
    hex?.startsWith('\\x') ? '0x' + hex.slice(2) : hex;

  return {
    async getInflightTransfers(params, _logger) {
      const routers = Object.values(params.routersByDomain);
      const domains = Object.keys(params.routersByDomain).map(Number);
      const query = `
        query InflightTransfers(
          $senders: [bytea!], $recipients: [bytea!],
          $originDomains: [Int!], $destDomains: [Int!],
          $limit: Int = 100
        ) {
          message_view(
            where: { _and: [
              { is_delivered: { _eq: false } },
              { sender: { _in: $senders } },
              { recipient: { _in: $recipients } },
              { origin_domain_id: { _in: $originDomains } },
              { destination_domain_id: { _in: $destDomains } }
            ] }
            order_by: { origin_tx_id: desc }
            limit: $limit
          ) { msg_id origin_domain_id destination_domain_id message_body }
        }`;

      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: {
            senders: routers.map(toBytea),
            recipients: routers.map(toBytea),
            originDomains: domains,
            destDomains: domains,
            limit: params.limit ?? 100,
          },
        }),
      });

      if (!res.ok) throw new Error(`Explorer query failed: ${res.status}`);
      const json = await res.json();
      return (json?.data?.message_view ?? []).map((msg: any) => ({
        msg_id: normalizeHex(msg.msg_id),
        origin_domain_id: msg.origin_domain_id,
        destination_domain_id: msg.destination_domain_id,
        message_body: normalizeHex(msg.message_body),
      }));
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const dbPath = config.dbPath ?? 'rebalancer-context.db';
  const contextStore = new SqliteContextStore(dbPath);
  const routeId = 'default';

  // Set up working directory
  const workDir = process.cwd();

  // Import rebalancer key into foundry keystore (skip if already exists)
  const keystoreDir = path.join(workDir, 'keystore');
  if (!fs.existsSync(keystoreDir)) {
    fs.mkdirSync(keystoreDir, { recursive: true });
  }
  const keystoreFile = path.join(keystoreDir, 'rebalancer');
  if (fs.existsSync(keystoreFile)) {
    console.log('Rebalancer keystore already exists, skipping import');
  } else {
    execSync(
      `cast wallet import rebalancer --private-key ${rebalancerKey} --keystore-dir ${keystoreDir} --unsafe-password ''`,
      { stdio: 'pipe' },
    );
    console.log('Imported rebalancer key into foundry keystore');
  }

  // Ensure skills are discoverable by the Pi agent
  const skillsSource = path.resolve(__dirname, '..', 'skills');
  const piDir = path.join(workDir, '.pi');
  const piSkillsLink = path.join(piDir, 'skills');
  if (fs.existsSync(skillsSource) && !fs.existsSync(piSkillsLink)) {
    if (!fs.existsSync(piDir)) fs.mkdirSync(piDir, { recursive: true });
    fs.symlinkSync(skillsSource, piSkillsLink);
    console.log(`Symlinked skills: ${piSkillsLink} → ${skillsSource}`);
  }

  // Write config (sans key) for the agent to read
  const configForFile = {
    chains: agentConfig.chains,
    rebalancerAddress: agentConfig.rebalancerAddress,
  };
  fs.writeFileSync(
    path.join(workDir, 'rebalancer-config.json'),
    JSON.stringify(configForFile, null, 2),
  );

  // Wire up explorer-based pending transfer provider if URL configured
  let pendingTransferProvider: PendingTransferProvider | undefined;
  if (config.explorerUrl) {
    const explorerClient = createExplorerClient(config.explorerUrl);
    pendingTransferProvider = new ExplorerPendingTransferProvider(
      explorerClient,
      agentConfig,
    );
    console.log(`Explorer pending transfers enabled: ${config.explorerUrl}`);
  }

  const customTools = buildCustomTools(
    agentConfig,
    contextStore,
    routeId,
    pendingTransferProvider,
  );
  const pollingIntervalMs = config.pollingIntervalMs ?? 30_000;

  console.log(
    `LLM Rebalancer starting (polling every ${pollingIntervalMs / 1000}s, db: ${dbPath})`,
  );

  let running = true;
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    running = false;
  });
  process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    running = false;
  });

  // Build initial prompt with context from store
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

  // Create persistent agent session
  let agent = await RebalancerAgent.create({
    workDir,
    provider: config.provider,
    model: config.model,
    agentsPrompt,
    customTools,
  });
  console.log('Agent session created (persistent across cycles)');

  while (running) {
    try {
      await agent.runCycle();
    } catch (error) {
      console.error('Cycle failed, recreating session:', error);
      try {
        agent.dispose();
        const ctx = await contextStore.get(routeId);
        let parsed: string | null = null;
        if (ctx) {
          try {
            parsed = JSON.parse(ctx).summary ?? ctx;
          } catch {
            parsed = ctx;
          }
        }
        const prompt = buildAgentsPrompt(agentConfig, config.strategy, parsed);
        agent = await RebalancerAgent.create({
          workDir,
          provider: config.provider,
          model: config.model,
          agentsPrompt: prompt,
          customTools,
        });
      } catch (recreateError) {
        console.error('Failed to recreate session:', recreateError);
      }
    }

    if (running) {
      await sleep(pollingIntervalMs);
    }
  }

  agent.dispose();
  contextStore.close();
  console.log('Rebalancer stopped.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
