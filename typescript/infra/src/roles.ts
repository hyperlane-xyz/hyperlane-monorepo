export enum Role {
  Validator = 'validator',
  Relayer = 'relayer',
  Scraper = 'scraper',
  Deployer = 'deployer',
  Kathy = 'kathy',
  Rebalancer = 'rebalancer',
}

export type FundableRole = Role.Relayer | Role.Kathy;

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
