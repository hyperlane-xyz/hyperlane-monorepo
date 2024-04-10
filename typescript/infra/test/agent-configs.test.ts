import { expect } from 'chai';

import { hyperlaneContextAgentChainConfig as mainnet3AgentChainConfig } from '../config/environments/mainnet3/agent.js';
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/chains.js';
import { hyperlaneContextAgentChainConfig as testnet4AgentChainConfig } from '../config/environments/testnet4/agent.js';
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/chains.js';
import { getAgentConfigJsonPath } from '../scripts/agent-utils.js';
import { ensureAgentChainConfigIncludesAllChainNames } from '../src/config/agent/agent.js';
import { readJSONAtPath } from '../src/utils/utils.js';

const environmentChainConfigs = {
  mainnet3: {
    agentChainConfig: mainnet3AgentChainConfig,
    // We read the agent config from the file system instead of importing
    // to get around the agent JSON configs living outside the typescript rootDir
    agentJsonConfig: readJSONAtPath(getAgentConfigJsonPath('mainnet')),
    supportedChainNames: mainnet3SupportedChainNames,
  },
  testnet4: {
    agentChainConfig: testnet4AgentChainConfig,
    agentJsonConfig: readJSONAtPath(getAgentConfigJsonPath('testnet')),
    supportedChainNames: testnet4SupportedChainNames,
  },
};

describe('Agent configs', () => {
  Object.entries(environmentChainConfigs).forEach(([environment, config]) => {
    describe(`Environment: ${environment}`, () => {
      it('AgentChainConfig specifies all chains for each role in the agent chain config', () => {
        // This will throw if there are any inconsistencies
        ensureAgentChainConfigIncludesAllChainNames(
          config.agentChainConfig,
          config.supportedChainNames,
        );
      });

      it('Agent JSON config matches environment chains', () => {
        const agentJsonConfigChains = Object.keys(
          config.agentJsonConfig.chains,
        );
        expect(agentJsonConfigChains).to.have.members(
          config.supportedChainNames,
        );
      });
    });
  });
});
