import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

/**
 * Test timeout for operations that require node startup and deployment
 */
export const DEFAULT_E2E_TEST_TIMEOUT = 100_000;

/**
 * Hyperlane Radix GitHub repository and version
 */
export const HYPERLANE_RADIX_GIT =
  'https://github.com/hyperlane-xyz/hyperlane-radix';
export const HYPERLANE_RADIX_VERSION = '1.1.0';

/**
 * Test private key for Radix local network
 * This matches the key used in CLI tests
 */
export const TEST_RADIX_PRIVATE_KEY =
  '0x8ef41fc20bf963ce18494c0f13e9303f70abc4c1d1ecfdb0a329d7fd468865b8';

/**
 * Test deployer address derived from TEST_RADIX_PRIVATE_KEY
 */
export const TEST_RADIX_DEPLOYER_ADDRESS =
  'account_loc12ytsy99ajzkwy7ce0444fs8avat7jy3fkj5mk64yz2z3yml6s7y7x3';

/**
 * Burn address for Radix local network
 */
export const TEST_RADIX_BURN_ADDRESS =
  'account_loc1294g56ga4ckdzhksx6vnrns2jj0v47ju87flsyscxdjxu9wrkjp5vt';

/**
 * Default test chain metadata for Radix local network
 */
export const TEST_RADIX_CHAIN_METADATA: TestChainMetadata = {
  name: 'radixtest',
  chainId: 240,
  domainId: 1421493353,
  nativeToken: {
    decimals: 18,
    name: 'Radix',
    symbol: 'XRD',
    denom:
      'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
  },
  blocks: {
    confirmations: 0,
    estimateBlockTime: 5,
  },
  gatewayUrls: [
    {
      http: 'http://127.0.0.1:5308',
    },
  ],
  rpcUrls: [
    {
      http: 'http://127.0.0.1:3333/core',
    },
  ],
  rpcPort: 3333,
  rpcUrl: 'http://127.0.0.1:3333',
  restPort: 3333,
};
