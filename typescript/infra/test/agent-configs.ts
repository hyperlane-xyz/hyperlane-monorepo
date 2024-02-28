import { expect } from 'chai';

import mainnet3AgentConfig from '../../../rust/config/mainnet3_config.json';
import testnet4AgentConfig from '../../../rust/config/testnet4_config.json';
import { hyperlaneContextAgentChainConfig as mainnet3AgentChainConfig } from '../config/environments/mainnet3/agent';
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/chains';
import { hyperlaneContextAgentChainConfig as testnet4AgentChainConfig } from '../config/environments/testnet4/agent';
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/chains';
import { ensureAgentChainConfigIncludesAllChainNames } from '../src/config';

const environmentChainConfigs = {
  mainnet3: {
    agentChainConfig: mainnet3AgentChainConfig,
    agentJsonConfig: mainnet3AgentConfig,
    supportedChainNames: mainnet3SupportedChainNames,
  },
  testnet4: {
    agentChainConfig: testnet4AgentChainConfig,
    agentJsonConfig: testnet4AgentConfig,
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
