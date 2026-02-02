import { type MinimumRequiredGasByAction } from '@hyperlane-xyz/provider-sdk';

export const ETHEREUM_MINIMUM_GAS: MinimumRequiredGasByAction = {
  CORE_DEPLOY_GAS: BigInt(1e8),
  WARP_DEPLOY_GAS: BigInt(3e7),
  ISM_DEPLOY_GAS: BigInt(5e5),
  TEST_SEND_GAS: BigInt(3e5),
  AVS_GAS: BigInt(3e6),
};

export const PROXY_DEPLOYED_URL = 'https://proxy.hyperlane.xyz';
export const EXPLORER_URL = 'https://explorer.hyperlane.xyz';
