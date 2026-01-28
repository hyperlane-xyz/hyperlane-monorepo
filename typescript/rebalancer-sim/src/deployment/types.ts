import type { Address } from '@hyperlane-xyz/utils';

/**
 * Configuration for a simulated chain domain
 */
export interface SimulatedChainConfig {
  chainName: string;
  domainId: number;
}

/**
 * Deployed addresses for a single domain
 */
export interface DeployedDomain {
  chainName: string;
  domainId: number;
  mailbox: Address;
  warpToken: Address;
  collateralToken: Address;
  bridge: Address;
}

/**
 * Complete multi-domain deployment result
 */
export interface MultiDomainDeploymentResult {
  anvilRpc: string;
  deployer: Address;
  deployerKey: string;
  /** Separate key for rebalancer (different nonce) */
  rebalancerKey: string;
  rebalancer: Address;
  /** Separate key for bridge controller (different nonce) */
  bridgeControllerKey: string;
  bridgeController: Address;
  /** Separate key for mailbox processor (different nonce) */
  mailboxProcessorKey: string;
  mailboxProcessor: Address;
  domains: Record<string, DeployedDomain>;
  /** Snapshot ID for resetting state */
  snapshotId: string;
}

/**
 * Options for multi-domain deployment
 */
export interface MultiDomainDeploymentOptions {
  /** RPC URL for anvil instance */
  anvilRpc: string;
  /** Deployer private key */
  deployerKey: string;
  /** Rebalancer private key (separate nonce from deployer) */
  rebalancerKey?: string;
  /** Bridge controller private key (separate nonce from deployer and rebalancer) */
  bridgeControllerKey?: string;
  /** Mailbox processor private key (separate nonce for processing mailbox messages) */
  mailboxProcessorKey?: string;
  /** Chain configurations to deploy */
  chains: SimulatedChainConfig[];
  /** Initial collateral balance per chain (in wei) */
  initialCollateralBalance: bigint;
  /** Token decimals */
  tokenDecimals?: number;
  /** Token symbol */
  tokenSymbol?: string;
  /** Token name */
  tokenName?: string;
}

/**
 * Default simulated chains for testing
 */
export const DEFAULT_SIMULATED_CHAINS: SimulatedChainConfig[] = [
  { chainName: 'chain1', domainId: 1000 },
  { chainName: 'chain2', domainId: 2000 },
  { chainName: 'chain3', domainId: 3000 },
];

/**
 * Default anvil deployer key (first account)
 */
export const ANVIL_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Default anvil deployer address
 */
export const ANVIL_DEPLOYER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * Second anvil account key (for rebalancer - separate nonce)
 */
export const ANVIL_REBALANCER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

/**
 * Second anvil account address
 */
export const ANVIL_REBALANCER_ADDRESS =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/**
 * Third anvil account key (for bridge controller - separate nonce)
 */
export const ANVIL_BRIDGE_CONTROLLER_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

/**
 * Third anvil account address
 */
export const ANVIL_BRIDGE_CONTROLLER_ADDRESS =
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/**
 * Fourth anvil account key (for mailbox processor - separate nonce)
 */
export const ANVIL_MAILBOX_PROCESSOR_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';

/**
 * Fourth anvil account address
 */
export const ANVIL_MAILBOX_PROCESSOR_ADDRESS =
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
