import { AgentChainNames, Role } from '../../../src/roles';

export const agentChainNames: AgentChainNames = {
  [Role.Validator]: testChainNames,
  [Role.Relayer]: testChainNames,
  [Role.Scraper]: testChainNames,
};
