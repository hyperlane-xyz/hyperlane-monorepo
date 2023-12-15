import { ChainMap, TokenType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

interface NativeTokenConfig {
  symbol: string;
  name: string;
  type: TokenType.native;
  decimals: number;
  hypNativeAddress: string;
  protocolType:
    | ProtocolType.Ethereum
    | ProtocolType.Sealevel
    | ProtocolType.Cosmos;
}

interface CollateralTokenConfig {
  type: TokenType.collateral;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  hypCollateralAddress: string;
  isSpl2022?: boolean;
  protocolType:
    | ProtocolType.Ethereum
    | ProtocolType.Sealevel
    | ProtocolType.Cosmos;
}

interface SyntheticTokenConfig {
  type: TokenType.synthetic;
  hypSyntheticAddress: string;
  decimals: number;
  symbol: string;
  name: string;
  protocolType:
    | ProtocolType.Ethereum
    | ProtocolType.Sealevel
    | ProtocolType.Cosmos;
}

// TODO: migrate and dedupe to SDK from infra and Warp UI
export type WarpTokenConfig = ChainMap<
  CollateralTokenConfig | NativeTokenConfig | SyntheticTokenConfig
>;

/// nautilus configs
export const nautilusList: WarpTokenConfig = {
  // bsc
  bsc: {
    type: TokenType.collateral,
    address: '0x37a56cdcD83Dce2868f721De58cB3830C44C6303',
    hypCollateralAddress: '0xC27980812E2E66491FD457D488509b7E04144b98',
    symbol: 'ZBC',
    name: 'Zebec',
    decimals: 9,
    protocolType: ProtocolType.Ethereum,
  },

  // nautilus
  nautilus: {
    type: TokenType.native,
    hypNativeAddress: '0x4501bBE6e731A4bC5c60C03A77435b2f6d5e9Fe7',
    symbol: 'ZBC',
    name: 'Zebec',
    decimals: 18,
    protocolType: ProtocolType.Ethereum,
  },

  // solana
  solana: {
    type: TokenType.collateral,
    address: 'wzbcJyhGhQDLTV1S99apZiiBdE4jmYfbw99saMMdP59',
    hypCollateralAddress: 'EJqwFjvVJSAxH8Ur2PYuMfdvoJeutjmH6GkoEFQ4MdSa',
    name: 'Zebec',
    symbol: 'ZBC',
    decimals: 9,
    isSpl2022: false,
    protocolType: ProtocolType.Sealevel,
  },
};

/// neutron configs
export const neutronList: WarpTokenConfig = {
  neutron: {
    type: TokenType.collateral,
    address:
      'ibc/773B4D0A3CD667B2275D5A4A7A2F0909C0BA0F4059C0B9181E680DDF4965DCC7',
    hypCollateralAddress:
      'neutron1ch7x3xgpnj62weyes8vfada35zff6z59kt2psqhnx9gjnt2ttqdqtva3pa',
    name: 'Celestia',
    symbol: 'TIA',
    decimals: 6,
    protocolType: ProtocolType.Cosmos,
  },
  mantapacific: {
    type: TokenType.synthetic,
    hypSyntheticAddress: '0x6Fae4D9935E2fcb11fC79a64e917fb2BF14DaFaa',
    name: 'Celestia',
    symbol: 'TIA',
    decimals: 6,
    protocolType: ProtocolType.Ethereum,
  },
};
