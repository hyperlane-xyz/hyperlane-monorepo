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
  [ProtocolType.Starknet]: {
    decimals: 18,
    denom: '0x49D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7',
    name: 'Ether',
    symbol: 'ETH',
  },
};
