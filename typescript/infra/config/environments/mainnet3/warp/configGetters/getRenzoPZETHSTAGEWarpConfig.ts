import { pick } from '@hyperlane-xyz/utils';

import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

import { ezEthStagingSafes } from './getRenzoEZETHSTAGEWarpConfig.js';
import {
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

const pzEthStagingExistingProtocolFeeAddresses = {
  berachain: '0xABe90B9b98d622D336Ae734962F2c0842aAFbc90',
  ethereum: '0x36f1Ab3Ce69fD858f31848E7aA39801A3ed3bb86',
  swell: '0x4Ff0fca64A89B5D8a26b6DA6011FE5A8B9Ba4f62',
  unichain: '0x881fb274e2E46586e3e3082B53494909348fE16D',
  zircuit: '0xE13C2a2D29EB836BD703E83d16c09288b1d64deF',
};

const pzEthStagingValidators = pick(ezEthValidators, pzEthChainsToDeploy);
const pzEthStagingSafes = pick(ezEthStagingSafes, pzEthChainsToDeploy);
export const pzEthProtocolFee = pick(
  pzEthStagingExistingProtocolFeeAddresses,
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
