import { GovernanceConfig } from '../../../src/governance';

const addresses = {
  alfajores: {
    recoveryManager: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
    governor: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
  },
  kovan: {
    recoveryManager: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
  },
};

export const governance: GovernanceConfig<keyof typeof addresses> = {
  recoveryTimelock: 180,
  addresses,
};
