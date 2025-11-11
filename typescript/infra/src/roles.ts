export enum Role {
  Validator = 'validator',
  Relayer = 'relayer',
  Scraper = 'scraper',
  Deployer = 'deployer',
  Kathy = 'kathy',
  Rebalancer = 'rebalancer',
}

export type FundableRole = Role.Relayer | Role.Kathy | Role.Rebalancer;

export const ALL_KEY_ROLES = [
  Role.Validator,
  Role.Relayer,
  Role.Deployer,
  Role.Kathy,
  Role.Rebalancer,
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

  // EVM operational roles
  EvmDeployer = 'evm-deployer',
  EvmLegacyDeployer = 'evm-legacy-deployer',
  EvmRebalancer = 'evm-rebalancer',
  EvmIgpClaimer = 'evm-igp-claimer',
  EvmIgpUpdater = 'evm-igp-updater',
}
