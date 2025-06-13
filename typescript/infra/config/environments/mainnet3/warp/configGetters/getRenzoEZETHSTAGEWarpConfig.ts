import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

import {
  ezEthChainsToDeploy,
  ezEthValidators,
  getRenzoWarpConfigGenerator,
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

const ezEthStageExistingProtocolFee: ChainMap<Address> = {
  arbitrum: '0x2Ef1A234D5dC658F0a4004a8783F3F12333c47d9',
  base: '0x5fA5E930678a501259b5025B06f9af90DafcC862',
  berachain: '0x6EFB7Fd2934db70dA2521Edc5AE5e5FcC59EaBB1',
  blast: '0xe35342b3A3a9eEd61B87158CD5fE7C7ac2c87716',
  bsc: '0x73c9627AEdBCe75247E1c8E05ED1A42b846a1d41',
  ethereum: '0xbBfDc1E764Da75893C813Ce8315eD72f36f1b2C4',
  fraxtal: '0x4E602f930a64CcaF3A270Da1c2223A9f5860AEE7',
  linea: '0xcB5D5609902eef08b2B975ed9F1df0992b55C910',
  mode: '0xAa4Be20E9957fE21602c74d7C3cF5CB1112EA9Ef',
  optimism: '0x1A7F6e01103D920d210f25e122d22E1182411868',
  sei: '0xB1150a7a1bc98d758eF9A364917A1309f2B18c63',
  swell: '0x2944D3377fd9414d7Ca5701a861E5Ef341eE6DC7',
  taiko: '0x9eEc4Bf68163b0AE77a58f3Fe48c8727C2269d6F',
  unichain: '0x855B945366cF7c59B1136F8cF1B00f87e96cf7dD',
  worldchain: '0xd16E378b0f2732E06f43b70Fa1B734C10B30BFCA',
  zircuit: '0xF59775A9a8C272ED0b0adF2435EbA2369229551D',
};

const ezEthStagingLockbox = '0x74c8290836612e6251E49e8f3198fdD80C4DbEB8';
export const getRenzoEZETHSTAGEWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: ezEthChainsToDeploy,
  validators: ezEthValidators,
  safes: ezEthStagingSafes,
  xERC20Addresses: ezEthStagingAddresses,
  xERC20Lockbox: ezEthStagingLockbox,
  existingProtocolFee: ezEthStageExistingProtocolFee,
  useLegacyHooks: false,
});

export const getEZETHSTAGEGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(ezEthStagingSafes);
