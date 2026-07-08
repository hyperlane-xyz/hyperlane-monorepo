export enum Role {
  Validator = 'validator',
  Relayer = 'relayer',
  Scraper = 'scraper',
  Deployer = 'deployer',
  Rebalancer = 'rebalancer',
  InventoryRebalancer = 'inventoryrebalancer',
  RebalancerStaging = 'rebalancerstaging',
  InventoryRebalancerStaging = 'inventoryrebalancerstaging',
  QuoteSigner = 'quotesigner',
  // Funding-only role: the stableswap rebalancer's EVM inventory
  // signer. Has no managed agent key — keyfunder only needs the address to
  // send gas to it. Do NOT add to ALL_KEY_ROLES / ALL_AGENT_ROLES / rolesWithKeys.
  StableswapInventoryRebalancer = 'stableswapinventoryrebalancer',
}

export type FundableRole =
  | Role.Relayer
  | Role.Rebalancer
  | Role.InventoryRebalancer
  | Role.StableswapInventoryRebalancer;

export const ALL_KEY_ROLES = [
  Role.Validator,
  Role.Relayer,
  Role.Deployer,
  Role.Rebalancer,
  Role.InventoryRebalancer,
  Role.RebalancerStaging,
  Role.InventoryRebalancerStaging,
  Role.QuoteSigner,
];

// Use a const assertion to tell the compiler to retain the literal array item types.
export const ALL_AGENT_ROLES = [
  Role.Validator,
  Role.Relayer,
  Role.Scraper,
] as const;
export type AgentRole = (typeof ALL_AGENT_ROLES)[number];
export type AgentChainNames = Record<AgentRole, string[]>;

/**
 * Turnkey operational roles (not agent roles)
 * These are used for one-off scripts and operational tasks with Turnkey signers
 */
export enum TurnkeyRole {
  // Sealevel roles
  SealevelDeployer = 'sealevel-deployer',

  // Imported keys aka "legacy"
  EvmLegacyDeployer = 'evm-legacy-deployer',
  EvmLegacyRebalancer = 'evm-legacy-rebalancer',

  // New turnkey-native keys
  EvmDeployer = 'evm-deployer',
  EvmRebalancer = 'evm-rebalancer',
  EvmIgpClaimer = 'evm-igp-claimer',
  EvmIgpUpdater = 'evm-igp-updater',
}
