import { GovernanceConfig } from '../../../src/governance';

export const governance: GovernanceConfig = {
  recoveryTimelock: 180,
  addresses: {
    alfajores: {
      recoveryManager: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
      governor: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
    },
    kovan: {
      recoveryManager: '0x3909CFACD7a568634716CbCE635F76b9Cf37364B',
    },
  },
};
