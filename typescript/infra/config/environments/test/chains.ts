import {
  testChainMetadata as defaultTestChainMetadata,
  testChains as defaultTestChains,
} from '@hyperlane-xyz/sdk';

import { AgentChainNames, Role } from '../../../src/roles.js';

export const testChainNames = defaultTestChains;
export const testChainMetadata = { ...defaultTestChainMetadata };

export const agentChainNames: AgentChainNames = {
  [Role.Validator]: testChainNames,
  [Role.Relayer]: testChainNames,
  [Role.Scraper]: testChainNames,
};
