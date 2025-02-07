import { agents as mainnet3Agents } from './mainnet3/agent.js';
import { agents as testAgents } from './test/agent.js';
import { agents as testnet4Agents } from './testnet4/agent.js';

export const agents = {
  mainnet3: mainnet3Agents,
  testnet4: testnet4Agents,
  test: testAgents,
};
