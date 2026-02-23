/**
 * Configuration types for the LLM rebalancer.
 *
 * The agent reads a JSON config file at runtime. These types define
 * the shape of that config and the options for session creation.
 */

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

/** Full config written to rebalancer-config.json for the agent */
export interface RebalancerAgentConfig {
  chains: Record<string, ChainConfig>;
  rebalancerAddress: string;
  rebalancerKey: string;
}

/** Strategy description — either prose or structured */
export type StrategyDescription =
  | { type: 'prose'; text: string }
  | {
      type: 'weighted';
      chains: Record<string, { weight: number; tolerance: number }>;
    }
  | {
      type: 'minAmount';
      chains: Record<
        string,
        { min: string; target: string; amountType: 'absolute' | 'relative' }
      >;
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
}
