import { expect } from 'chai';

import { Contexts } from '../config/contexts';
import { hyperlaneContextAgentChainConfig as mainnet3AgentChainConfig } from '../config/environments/mainnet3/agent';
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/chains';
import { hyperlaneContextAgentChainConfig as testnet4AgentChainConfig } from '../config/environments/testnet4/agent';
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/chains';
import { AgentAwsKey } from '../src/agents/aws';
import { AgentGCPKey } from '../src/agents/gcp';
import { ReadOnlyCloudAgentKey } from '../src/agents/keys';
import { ensureAgentChainConfigIncludesAllChainNames } from '../src/config';
import { Role } from '../src/roles';

const environmentChainConfigs = {
  mainnet3: {
    agentChainConfig: mainnet3AgentChainConfig,
    supportedChainNames: mainnet3SupportedChainNames,
  },
  testnet4: {
    agentChainConfig: testnet4AgentChainConfig,
    supportedChainNames: testnet4SupportedChainNames,
  },
};

describe('Environment agent chain configs', () => {
  Object.entries(environmentChainConfigs).forEach(([environment, config]) => {
    describe(`Environment: ${environment}`, () => {
      it('Specifies all chains for each role in the agent chain config', () => {
        // This will throw if there are any inconsistencies
        ensureAgentChainConfigIncludesAllChainNames(
          config.agentChainConfig,
          config.supportedChainNames,
        );
      });
    });
  });
});
