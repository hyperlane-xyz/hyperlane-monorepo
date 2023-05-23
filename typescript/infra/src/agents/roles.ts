export enum KEY_ROLE_ENUM {
  Validator = 'validator',
  Relayer = 'relayer',
  Scraper = 'scraper',
  Deployer = 'deployer',
  Bank = 'bank',
  Kathy = 'kathy',
}

export const ALL_KEY_ROLES = [
  KEY_ROLE_ENUM.Validator,
  KEY_ROLE_ENUM.Relayer,
  KEY_ROLE_ENUM.Scraper,
  KEY_ROLE_ENUM.Deployer,
  KEY_ROLE_ENUM.Bank,
  KEY_ROLE_ENUM.Kathy,
];

export const ALL_AGENT_ROLES = [
  KEY_ROLE_ENUM.Validator,
  KEY_ROLE_ENUM.Relayer,
  KEY_ROLE_ENUM.Scraper,
];
