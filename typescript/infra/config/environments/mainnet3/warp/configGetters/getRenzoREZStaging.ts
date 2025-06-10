import { pick } from '@hyperlane-xyz/utils';

import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';

import {
  ezEthValidators,
  getRenzoWarpConfigGenerator,
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
const rezStagingExistingProtocolFeeAddresses = {
  base: '0xe588d064639C6F68ECF947E8C1f94A6e744437bD',
  ethereum: '0x017D657a95661EcBC7C23A59D65Da94f3660B685',
  unichain: '0x98996dD4CFb5b989D264D17887AA53B165ad3A8b',
};
const rezEthValidators = pick(ezEthValidators, rezEthChainsToDeploy);
const rezEthSafes = pick(rezStagingSafes, rezEthChainsToDeploy);
const rezExistingProtocolFee = pick(
  rezStagingExistingProtocolFeeAddresses,
  rezEthChainsToDeploy,
);

export const getRezStagingWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: rezEthChainsToDeploy,
  validators: rezEthValidators,
  safes: rezEthSafes,
  xERC20Addresses: rezStagingAddresses,
  xERC20Lockbox: rezStagingLockbox,
  existingProtocolFee: rezExistingProtocolFee,
});

export const getRezStagingGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(rezStagingSafes);
