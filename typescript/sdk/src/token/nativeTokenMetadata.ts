import { ProtocolType } from '@hyperlane-xyz/utils';

import { NativeToken } from '../metadata/chainMetadataTypes.js';

export const PROTOCOL_TO_DEFAULT_NATIVE_TOKEN: Record<
  ProtocolType,
  NativeToken
> = {
  [ProtocolType.Ethereum]: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  [ProtocolType.Sealevel]: {
    decimals: 9,
    name: 'Solana',
    symbol: 'SOL',
  },
  [ProtocolType.Cosmos]: {
    decimals: 6,
    denom: 'uatom',
    name: 'Atom',
    symbol: 'ATOM',
  },
  [ProtocolType.CosmosNative]: {
    decimals: 6,
    denom: 'uatom',
    name: 'Atom',
    symbol: 'ATOM',
  },
  [ProtocolType.Starknet]: {
    decimals: 18,
    denom: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
    name: 'Ether',
    symbol: 'ETH',
  },
};
