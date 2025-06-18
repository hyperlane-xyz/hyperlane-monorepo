import { ProtocolType } from '@hyperlane-xyz/utils';

export const MINIMUM_CORE_DEPLOY_GAS = {
  [ProtocolType.Ethereum]: (1e8).toString(),
  [ProtocolType.CosmosNative]: (1e8).toString(),
};
export const MINIMUM_WARP_DEPLOY_GAS = {
  [ProtocolType.Ethereum]: (1e7).toString(),
  [ProtocolType.CosmosNative]: (1e7).toString(),
};
export const MINIMUM_TEST_SEND_GAS = {
  [ProtocolType.Ethereum]: (1e5).toString(),
  [ProtocolType.CosmosNative]: (1e5).toString(),
};
export const MINIMUM_AVS_GAS = {
  [ProtocolType.Ethereum]: (1e6).toString(),
  [ProtocolType.CosmosNative]: (1e6).toString(),
};

export const PROXY_DEPLOYED_URL = 'https://proxy.hyperlane.xyz';
export const EXPLORER_URL = 'https://explorer.hyperlane.xyz';
