import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

import {
  ezEthChainsToDeploy,
  ezEthValidators,
  getRenzoWarpConfigGenerator,
  renzoTokenPrices,
} from './getRenzoEZETHWarpConfig.js';

const ezEthStagingAddresses: Record<
  (typeof ezEthChainsToDeploy)[number],
  string
> = {
  arbitrum: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  optimism: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  base: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  blast: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  bsc: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  mode: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  linea: '0x5EA461E19ba6C002b7024E4A2e9CeFe79a47d3bB',
  ethereum: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  fraxtal: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  zircuit: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  taiko: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  sei: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  swell: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  unichain: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  berachain: '0x585afea249031Ea4168A379F664e91dFc5F77E7D',
  worldchain: '0xC33DdE0a44e3Bed87cc3Ff0325D3fcbA5279930E',
};

export const ezEthStagingSafes: Record<
  (typeof ezEthChainsToDeploy)[number],
  string
> = {
  arbitrum: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  optimism: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  base: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  blast: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  bsc: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  mode: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  linea: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  ethereum: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  fraxtal: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  zircuit: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  taiko: '0x31FF35F84ADB120DbE089D190F03Ac74731Ae83F',
  sei: '0xa30FF77d30Eb2d785f574344B4D11CAAe1949807',
  swell: '0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115',
  unichain: '0x9D5FCF39FF17a67eB9CB4505f83920519EfEB01B',
  berachain: '0xf013c8Be28421b050cca5bD95cc57Af49568e8be',
  worldchain: '0x3DA9AE6359Ad3eFFD33Ad334ae12bE55904BE4eA',
};

const ezEthStagingLockbox = '0x74c8290836612e6251E49e8f3198fdD80C4DbEB8';
export const getRenzoEZETHSTAGEWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: ezEthChainsToDeploy,
  validators: ezEthValidators,
  safes: ezEthStagingSafes,
  xERC20Addresses: ezEthStagingAddresses,
  xERC20Lockbox: ezEthStagingLockbox,
  tokenPrices: renzoTokenPrices,
});

export const getEZETHSTAGEGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(ezEthStagingSafes);
