import { pick } from '@hyperlane-xyz/utils';

import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

import { ezEthStagingSafes } from './getRenzoEZETHSTAGEWarpConfig.js';
import {
  ezEthProdExistingProtocolFeeAddresses,
  ezEthValidators,
  getRenzoWarpConfigGenerator,
} from './getRenzoEZETHWarpConfig.js';
import { pzEthChainsToDeploy } from './getRenzoPZETHWarpConfig.js';

const pzEthStagingLockbox = '0x9E1a2b6de93164b77Fc5CA11e647EECB38BB463D';
const pzEthStagingAddresses = {
  ethereum: '0xDe9e4211087A43112b0e0e9d840459Acf1d9E6C8',
  zircuit: '0xDe9e4211087A43112b0e0e9d840459Acf1d9E6C8',
  swell: '0xDe9e4211087A43112b0e0e9d840459Acf1d9E6C8',
  unichain: '0xDe9e4211087A43112b0e0e9d840459Acf1d9E6C8',
  berachain: '0xDe9e4211087A43112b0e0e9d840459Acf1d9E6C8',
};

const pzEthStagingValidators = pick(ezEthValidators, pzEthChainsToDeploy);
const pzEthStagingSafes = pick(ezEthStagingSafes, pzEthChainsToDeploy);
export const pzEthProtocolFee = pick(
  ezEthProdExistingProtocolFeeAddresses,
  pzEthChainsToDeploy,
);

export const getRenzoPZETHStagingWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: pzEthChainsToDeploy,
  validators: pzEthStagingValidators,
  safes: pzEthStagingSafes,
  xERC20Addresses: pzEthStagingAddresses,
  xERC20Lockbox: pzEthStagingLockbox,
  existingProtocolFee: pzEthProtocolFee,
  useLegacyHooks: true,
});

export const getPZETHSTAGEGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(pzEthStagingSafes);
