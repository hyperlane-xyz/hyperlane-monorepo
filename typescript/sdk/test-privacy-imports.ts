/**
 * Quick test to verify privacy warp route type imports compile
 */

// Test type imports
import type {
  PrivateNativeConfig,
  PrivateCollateralConfig,
  PrivateSyntheticConfig,
} from './src/token/types.js';

// Test adapter imports
import type {
  BasePrivateWarpOriginAdapter,
  EvmHypPrivateNativeAdapter,
  EvmHypPrivateCollateralAdapter,
  EvmHypPrivateSyntheticAdapter,
} from './src/token/adapters/PrivateWarpOriginAdapter.js';

import type { AleoPrivacyHubAdapter } from './src/token/adapters/AleoPrivacyHubAdapter.js';

// Test that types are defined correctly
const testConfig: PrivateNativeConfig = {
  type: 'privateNative',
  aleoPrivacyHub: '0x' + '0'.repeat(40),
  aleoDomain: 999001,
};

console.log('Privacy imports compile successfully!', testConfig);
