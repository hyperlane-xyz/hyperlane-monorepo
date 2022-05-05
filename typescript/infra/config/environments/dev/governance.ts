import { ChainMap } from '@abacus-network/sdk';

import { GovernanceConfig } from '../../../src/governance';

import { DevNetworks } from './domains';

const defaultGovernanceConfig = {
  recoveryManager: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
  recoveryTimelock: 180,
};

const addresses = {
  alfajores: {
    ...defaultGovernanceConfig,
    governor: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
  },
  kovan: defaultGovernanceConfig,
};

export const governance: ChainMap<DevNetworks, GovernanceConfig> = addresses;
