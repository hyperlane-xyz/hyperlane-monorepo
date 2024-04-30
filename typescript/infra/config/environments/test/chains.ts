import { testChains } from '@hyperlane-xyz/sdk';

import { AgentChainNames, Role } from '../../../src/roles.js';

export const testChainNames = testChains;

export const agentChainNames: AgentChainNames = {
  [Role.Validator]: testChains,
  [Role.Relayer]: testChains,
  [Role.Scraper]: testChains,
};
