import { agents as mainnet3Agents } from './mainnet3/agent';
import { agents as testAgents } from './test/agent';
import { agents as testnet4Agents } from './testnet4/agent';

export const agents = {
  mainnet3: mainnet3Agents,
  testnet4: testnet4Agents,
  test: testAgents,
};
