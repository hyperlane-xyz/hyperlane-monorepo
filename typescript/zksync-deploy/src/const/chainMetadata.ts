import { ChainMetadata, ExplorerFamily } from '../metadata/chainMetadataTypes';
import { ChainMap } from '../types';

// FIXME:
export const zksyncera: ChainMetadata = {
  blockExplorers: [
    {
      apiUrl: 'https://api.arbiscan.io/api',
      family: ExplorerFamily.Etherscan,
      name: 'Arbiscan',
      url: 'https://arbiscan.io',
    },
  ],
  blocks: {
    confirmations: 1,
    estimateBlockTime: 3,
    reorgPeriod: 0,
  },
  chainId: 42161,
  displayName: 'Arbitrum',
  domainId: 42161,
  gasCurrencyCoinGeckoId: 'ethereum',
  // ETH is used for gas
  gnosisSafeTransactionServiceUrl:
    'https://safe-transaction-arbitrum.safe.global/',
  name: Chains.arbitrum,
  nativeToken: etherToken,
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://arb1.arbitrum.io/rpc' }],
};

export const chainMetadata: ChainMap<ChainMetadata> = {
  zksyncera,
};
