import {
  ChainAddresses,
  RegistryContent,
  WarpRouteConfigMap,
} from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

// Mock constants from existing registry tests
export const MOCK_CHAIN_NAME = 'mockchain';
export const MOCK_CHAIN_NAME_2 = 'mockchain2';
export const MOCK_ADDRESS = '0x0000000000000000000000000000000000000001';
export const MOCK_DISPLAY_NAME = 'faketherum';
export const MOCK_SYMBOL = 'MOCK';

export const mockChainMetadata: ChainMetadata = {
  chainId: 1337,
  domainId: 1337,
  name: MOCK_CHAIN_NAME,
  displayName: MOCK_DISPLAY_NAME,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://mock-rpc.com' }],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 12,
    reorgPeriod: 2,
  },
};

export const mockChainMetadataMap: Record<string, ChainMetadata> = {
  [MOCK_CHAIN_NAME]: mockChainMetadata,
};

export const mockChainAddresses: ChainAddresses = {
  mailbox: MOCK_ADDRESS,
  interchainGasPaymaster: '0x0000000000000000000000000000000000000002',
};

export const mockChainAddressesMap: Record<string, ChainAddresses> = {
  [MOCK_CHAIN_NAME]: mockChainAddresses,
};

export const mockChains = [MOCK_CHAIN_NAME, 'ethereum', 'polygon'];

export const mockWarpRoutes: WarpCoreConfig[] = [
  {
    tokens: [
      {
        chainName: MOCK_CHAIN_NAME,
        standard: TokenStandard.ERC20,
        addressOrDenom: MOCK_ADDRESS,
        symbol: MOCK_SYMBOL,
        name: 'Mock Token',
        decimals: 18,
      },
    ],
  },
];

export const mockWarpRouteDeploys: WarpRouteDeployConfig[] = [
  {
    [MOCK_CHAIN_NAME]: {
      type: TokenType.native,
      owner: MOCK_ADDRESS,
    },
    [MOCK_CHAIN_NAME_2]: {
      type: TokenType.synthetic,
      owner: MOCK_ADDRESS,
    },
  },
];

export const mockWarpRouteMap: WarpRouteConfigMap = {
  'test-warp-route': mockWarpRoutes[0],
};

export const mockRegistryContent: RegistryContent = {
  chains: {
    ethereum: { metadata: 'chains/ethereum/metadata.yaml' },
    polygon: { metadata: 'chains/polygon/metadata.yaml' },
  },
  deployments: {
    warpRoutes: {
      'warp-route-1': 'deployments/warp_routes/warp-route-1.yaml',
      'warp-route-2': 'deployments/warp_routes/warp-route-2.yaml',
    },
    warpDeployConfig: {},
  },
};
