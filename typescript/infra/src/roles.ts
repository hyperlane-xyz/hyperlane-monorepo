export enum Role {
  Validator = 'validator',
  Relayer = 'relayer',
  Scraper = 'scraper',
  Deployer = 'deployer',
  Bank = 'bank',
  Kathy = 'kathy',
}

export const ALL_KEY_ROLES = [
  Role.Validator,
  Role.Relayer,
  Role.Deployer,
  Role.Bank,
  Role.Kathy,
];

export const ALL_AGENT_ROLES = [Role.Validator, Role.Relayer, Role.Scraper];
