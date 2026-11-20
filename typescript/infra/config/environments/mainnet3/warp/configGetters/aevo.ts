import { Address } from '@hyperlane-xyz/utils';

import { DEPLOYER } from '../../owners.js';

// Per-chain router owners shared by the Aevo USDC and WETH warp route getters.
export type AevoOwners = Record<
  'aevo' | 'optimism' | 'arbitrum' | 'base',
  Address
>;

export const AEVO_STAGING_OWNERS: AevoOwners = {
  aevo: DEPLOYER,
  optimism: DEPLOYER,
  arbitrum: DEPLOYER,
  base: DEPLOYER,
};

// TODO(aevo-prod-owner): placeholder, NOT a real owner. Aevo must provide the
// real prod owners (multisig / ICA / Safe, never an EOA) before any prod export
// or deploy. Until the SDK tolerates limit-less xERC20 tokens, the router owner
// must be final at deploy time: `EvmWarpModule.update` runs the xERC20 module
// for any xERC20 leg, which derives the xERC20 type on-chain (setLimits /
// setBufferCap) and throws for a token implementing neither, so every
// `warp apply` that includes the aevo leg fails, not only owner changes.
const AEVO_PROD_OWNER_PLACEHOLDER =
  '0x000000000000000000000000000000000000dEaD';

export const AEVO_PROD_OWNERS: AevoOwners = {
  aevo: AEVO_PROD_OWNER_PLACEHOLDER,
  optimism: AEVO_PROD_OWNER_PLACEHOLDER,
  arbitrum: AEVO_PROD_OWNER_PLACEHOLDER,
  base: AEVO_PROD_OWNER_PLACEHOLDER,
};
