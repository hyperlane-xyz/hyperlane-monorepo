import {
  GasAction,
  type MinimumRequiredGasByAction,
} from '@hyperlane-xyz/provider-sdk';

export const ETHEREUM_MINIMUM_GAS: MinimumRequiredGasByAction = {
  [GasAction.CORE_DEPLOY_GAS]: BigInt(1e8),
  [GasAction.WARP_DEPLOY_GAS]: BigInt(3e7),
  [GasAction.ISM_DEPLOY_GAS]: BigInt(5e5),
  [GasAction.TEST_SEND_GAS]: BigInt(3e5),
  [GasAction.AVS_GAS]: BigInt(3e6),
};

export const PROXY_DEPLOYED_URL = 'https://proxy.hyperlane.xyz';
export const EXPLORER_URL = 'https://explorer.hyperlane.xyz';
