import { ChainMap } from '@abacus-network/sdk';

import { GovernanceConfig } from '../../../src/governance';

const defaultGovernanceConfig: GovernanceConfig = {
  recoveryManager: '0xfaD1C94469700833717Fa8a3017278BC1cA8031C',
  recoveryTimelock: 180,
};

const addresses = {
  alfajores: {
    ...defaultGovernanceConfig,
    governor: '0xfaD1C94469700833717Fa8a3017278BC1cA8031C',
  },
  kovan: defaultGovernanceConfig,
  fuji: defaultGovernanceConfig,
  mumbai: defaultGovernanceConfig,
  bsctestnet: defaultGovernanceConfig,
  arbitrumrinkeby: defaultGovernanceConfig,
  optimismkovan: defaultGovernanceConfig,
};

export const governance: ChainMap<keyof typeof addresses, GovernanceConfig> =
  addresses;
