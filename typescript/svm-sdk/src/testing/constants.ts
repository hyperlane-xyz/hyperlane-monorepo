import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

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
