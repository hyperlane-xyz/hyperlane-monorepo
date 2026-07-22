import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

export const DEFAULT_E2E_TEST_TIMEOUT = 300_000;

export const STARKNET_DEVNET_IMAGE = 'shardlabs/starknet-devnet-rs';
export const STARKNET_DEVNET_TAG = '0.4.2';

export const TEST_STARKNET_PRIVATE_KEY =
  '0x0000000000000000000000000000000071d7bb07b9a64f6f78ac4c816aff4da9';
export const TEST_STARKNET_ACCOUNT_ADDRESS =
  '0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691';

export const TEST_STARKNET_CHAIN_METADATA: TestChainMetadata = {
  name: 'starknetdevnet',
  protocol: ProtocolType.Starknet,
  chainId: '0x534e5f5345504f4c4941',
  domainId: 5854809,
  nativeToken: {
    decimals: 18,
    name: 'StarkNet Token',
    symbol: 'STRK',
    denom: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  },
  blocks: {
    confirmations: 0,
    estimateBlockTime: 0.5,
  },
  rpcUrls: [{ http: 'http://127.0.0.1:5050' }],
  rpcPort: 5050,
  rpcUrl: 'http://127.0.0.1:5050',
  restPort: 5050,
};
