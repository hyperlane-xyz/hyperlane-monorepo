/**
 * Configuration types for the LLM rebalancer.
 *
 * The agent reads a JSON config file at runtime. These types define
 * the shape of that config and the options for session creation.
 */

import type { ContextStore } from './context-store.js';

/** Per-asset deployment info within a chain */
export interface AssetConfig {
  symbol: string;
  decimals: number;
  warpToken: string;
  collateralToken: string;
  bridge: string;
}

/** Per-chain deployment info */
export interface ChainConfig {
  chainName: string;
  domainId: number;
  rpcUrl: string;
  mailbox: string;
  warpToken: string;
  collateralToken: string;
  bridge: string;
  assets?: Record<string, AssetConfig>;
}

/**
 * Full config written to rebalancer-config.json for the agent.
 * Note: rebalancerKey is NOT included — it stays in tool closures only.
 */
export interface RebalancerAgentConfig {
  chains: Record<string, ChainConfig>;
  rebalancerAddress: string;
  rebalancerKey: string;
  /** Hyperlane Explorer GraphQL URL for pending transfer queries */
  explorerUrl?: string;
}

/** Strategy description — either prose or structured */
export type StrategyDescription =
  | { type: 'prose'; text: string; routeHints?: string; policyProse?: string }
  | {
      type: 'weighted';
      chains: Record<string, { weight: number; tolerance: number }>;
      routeHints?: string;
      policyProse?: string;
    }
  | {
      type: 'minAmount';
      chains: Record<
        string,
        { min: string; target: string; amountType: 'absolute' | 'relative' }
      >;
      routeHints?: string;
      policyProse?: string;
    };

/** Options for creating the LLM rebalancer agent */
export interface LLMRebalancerOptions {
  /** Model provider (default: 'anthropic') */
  provider?: string;
  /** Model name (default: 'claude-sonnet-4-5') */
  model?: string;
  /** Working directory for the agent (temp dir in sim) */
  workDir: string;
  /** Path to the skills directory in the llm-rebalancer package */
  skillsDir: string;
  /** Strategy description */
  strategy: StrategyDescription;
  /** Agent config (written to rebalancer-config.json) */
  agentConfig: RebalancerAgentConfig;
  /** Polling interval in ms between rebalancer cycles */
  pollingIntervalMs: number;
  /** Context store for persisting LLM summaries between cycles */
  contextStore?: ContextStore;
  /** Route identifier for context store keying */
  routeId?: string;
  /** Adaptive polling intervals based on cycle outcome */
  adaptivePolling?: {
    /** Interval when pending actions exist (default: 30s) */
    shortIntervalMs: number;
    /** Interval when balanced (default: 300s) */
    longIntervalMs: number;
  };
  /** Max time (ms) for a single cycle before aborting (default: 120000) */
  cycleTimeoutMs?: number;
  /** Max tool calls per cycle before aborting (default: 25) */
  maxToolCallsPerCycle?: number;
}
