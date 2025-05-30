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
    denom: '0x04718f5a0Fc34cC1AF16A1cdee98fFB20C31f5cD61D6Ab07201858f4287c938D',
    name: 'Starknet Token',
    symbol: 'STRK',
  },
};
