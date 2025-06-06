import { pick } from '@hyperlane-xyz/utils';

import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

import {
  ezEthValidators,
  getRenzoWarpConfigGenerator,
  renzoTokenPrices,
} from './getRenzoEZETHWarpConfig.js';
import { rezEthChainsToDeploy } from './getRenzoREZBaseEthereum.js';

const rezStagingLockbox = '0xc693943eACc1Cb74b748Cf1B953946970b239279';
export const rezStagingSafes: Record<
  (typeof rezEthChainsToDeploy)[number],
  string
> = {
  base: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  ethereum: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
  unichain: '0xA9421c6F339eC414b7e77449986bE9C2Ae430C25',
};
const rezStagingAddresses = {
  ethereum: '0x19c5C2316171A2cff8773435a9A5F3f0e3eaB14B',
  base: '0x19c5C2316171A2cff8773435a9A5F3f0e3eaB14B',
  unichain: '0x19c5C2316171A2cff8773435a9A5F3f0e3eaB14B',
};

const rezEthValidators = pick(ezEthValidators, rezEthChainsToDeploy);
const rezEthSafes = pick(rezStagingSafes, rezEthChainsToDeploy);
const rezEthTokenPrices = pick(renzoTokenPrices, rezEthChainsToDeploy);

export const getRezStagingWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: rezEthChainsToDeploy,
  validators: rezEthValidators,
  safes: rezEthSafes,
  xERC20Addresses: rezStagingAddresses,
  xERC20Lockbox: rezStagingLockbox,
  tokenPrices: rezEthTokenPrices,
  useLegacyRoutingHook: true,
});

export const getRezStagingGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(rezStagingSafes);
