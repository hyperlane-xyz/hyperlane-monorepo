import { MINIMUM_GAS } from '@hyperlane-xyz/utils';

export const ETHEREUM_MINIMUM_GAS: MINIMUM_GAS = {
  CORE_DEPLOY_GAS: (1e8).toString(),
  WARP_DEPLOY_GAS: (3e7).toString(),
  TEST_SEND_GAS: (3e5).toString(),
  AVS_GAS: (3e6).toString(),
};

export const PROXY_DEPLOYED_URL = 'https://proxy.hyperlane.xyz';
export const EXPLORER_URL = 'https://explorer.hyperlane.xyz';
