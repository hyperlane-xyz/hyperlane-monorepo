export enum KeyRole {
  Validator = 'validator',
  Relayer = 'relayer',
  Scraper = 'scraper',
  Deployer = 'deployer',
  Bank = 'bank',
  Kathy = 'kathy',
}

export const ALL_KEY_ROLES = [
  KeyRole.Validator,
  KeyRole.Relayer,
  KeyRole.Scraper,
  KeyRole.Deployer,
  KeyRole.Bank,
  KeyRole.Kathy,
];

export const ALL_AGENT_ROLES = [
  KeyRole.Validator,
  KeyRole.Relayer,
  KeyRole.Scraper,
];
