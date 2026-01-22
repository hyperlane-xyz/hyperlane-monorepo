import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

/**
 * Test timeout for operations that require node startup and deployment
 */
export const DEFAULT_E2E_TEST_TIMEOUT = 100_000;

/**
 * Default test chain metadata for Cosmos local network
 */
export const TEST_COSMOS_CHAIN_METADATA: TestChainMetadata = {
  bech32Prefix: 'hyp',
  chainId: 'hyperlane-local-1',
  protocol: ProtocolType.CosmosNative,
  domainId: 758986691,
  name: 'hyp1',
  nativeToken: {
    decimals: 6,
    name: 'TEST',
    symbol: 'TEST',
    denom: 'uhyp',
  },
  rpcUrls: [
    {
      http: 'http://127.0.0.1:26657',
    },
  ],
  rpcPort: 26657,
  rpcUrl: 'http://127.0.0.1:26657',
  restPort: 1317,
};
