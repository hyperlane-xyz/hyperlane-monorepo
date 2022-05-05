import { ChainMap } from '@abacus-network/sdk';
import { GovernanceConfig } from '../../../src/governance';
import { TestNetworks } from './domains';

const defaultGovernanceConfig: GovernanceConfig = {
  recoveryManager: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  recoveryTimelock: 180,
}

const addresses = {
  test1: {
    ...defaultGovernanceConfig,
    governor: '0x4FbBB2b0820CF0cF027BbB58DC7F7f760BC0c57e',
  },
  test2: defaultGovernanceConfig,
  test3: defaultGovernanceConfig,
};

export const governance: ChainMap<TestNetworks, GovernanceConfig> =
  addresses

