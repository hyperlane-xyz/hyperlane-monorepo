import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

// Single source of truth for the Agave/Solana version used in tests.
// When bumping, also update the Dockerfile ARG + SHA256 and rebuild the image.
export const AGAVE_VERSION = 'v3.0.14';

export const TEST_SVM_CHAIN_METADATA = {
  name: 'svmtest',
  protocol: ProtocolType.Sealevel,
  domainId: 1399811149,
  chainId: '1399811149',
  nativeToken: { decimals: 9, name: 'SOL', symbol: 'SOL' },
  rpcUrls: [{ http: 'http://127.0.0.1:8899' }],
  rpcPort: 8899,
  rpcUrl: 'http://127.0.0.1:8899',
  restPort: 8899,
} as const satisfies TestChainMetadata;
