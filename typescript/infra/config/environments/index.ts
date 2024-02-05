import { environment as mainnet3 } from './mainnet3';
import { agents as mainnet3Agents } from './mainnet3/agent';
import { environment as test } from './test';
import { agents as testAgents } from './test/agent';
import { environment as testnet4 } from './testnet4';
import { agents as testnet4Agents } from './testnet4/agent';

export const environments = {
  test,
  testnet4,
  mainnet3,
};

export const agents = {
  mainnet3: mainnet3Agents,
  testnet4: testnet4Agents,
  test: testAgents,
};
