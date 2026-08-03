import { ChainMap, HypTokenRouterConfig } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

import {
  DeploymentChain,
  FeeChain,
  buildWBTCWarpConfig,
} from './getWBTCWarpConfig.js';

/**
 * WBTC — staging variant (AW-737).
 *
 * Identical to the production route except that every contract (router + fee) is
 * owned by the Haggis GCP deployer key so test changes are easy. The staging
 * OffchainQuotedLinearFee additionally authorises the deployer key as a quote
 * signer so fees can be re-quoted in staging without a production signer.
 */

// Haggis GCP deployer key (EVM/TVM)
const DEPLOYER_EVM = '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913';
// Haggis GCP deployer key (SVM)
const DEPLOYER_SVM = 'Fkf5uWVPjj8Dvg716mUYQ2tRpeZpGhib8qme4k34uZy3';

const stagingOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: DEPLOYER_EVM,
  bsc: DEPLOYER_EVM,
  tron: DEPLOYER_EVM,
  solanamainnet: DEPLOYER_SVM,
};

const stagingFeeOwnersByChain: Record<FeeChain, string> = {
  ethereum: DEPLOYER_EVM,
  bsc: DEPLOYER_EVM,
  tron: DEPLOYER_EVM,
};

// Production quote signers (0xEd18… = hyperlane-mainnet3-key-quotesigner, 0x22EA…)
// plus the deployer key for easy staging re-quotes.
const STAGING_QUOTE_SIGNERS = [
  '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
  '0x22EA0e66c9aFe2879135f4d16B5627454C53877e',
  DEPLOYER_EVM,
];

export const getWBTCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildWBTCWarpConfig(routerConfig, {
    ownersByChain: stagingOwnersByChain,
    feeOwnersByChain: stagingFeeOwnersByChain,
    quoteSigners: STAGING_QUOTE_SIGNERS,
  });
