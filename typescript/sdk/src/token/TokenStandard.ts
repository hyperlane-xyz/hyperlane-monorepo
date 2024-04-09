import { ProtocolType, objMap } from '@hyperlane-xyz/utils';

import {
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProviderType,
} from '../providers/ProviderType.js';

import { TokenType } from './config.js';

export enum TokenStandard {
  // EVM
  ERC20 = 'ERC20',
  ERC721 = 'ERC721',
  EvmNative = 'EvmNative',
  EvmHypNative = 'EvmHypNative',
  EvmHypCollateral = 'EvmHypCollateral',
  EvmHypcollateralVault = 'EvmHypcollateralVault',
  EvmHypSynthetic = 'EvmHypSynthetic',

  // Sealevel (Solana)
  SealevelSpl = 'SealevelSpl',
  SealevelSpl2022 = 'SealevelSpl2022',
  SealevelNative = 'SealevelNative',
  SealevelHypNative = 'SealevelHypNative',
  SealevelHypCollateral = 'SealevelHypCollateral',
  SealevelHypSynthetic = 'SealevelHypSynthetic',

  // Cosmos
  CosmosIcs20 = 'CosmosIcs20',
  CosmosIcs721 = 'CosmosIcs721',
  CosmosNative = 'CosmosNative',
  CosmosIbc = 'CosmosIbc',

  // CosmWasm
  CW20 = 'CW20',
  CWNative = 'CWNative',
  CW721 = 'CW721',
  CwHypNative = 'CwHypNative',
  CwHypCollateral = 'CwHypCollateral',
  CwHypSynthetic = 'CwHypSynthetic',

  // Fuel (TODO)
  FuelNative = 'FuelNative',
}

// Allows for omission of protocol field in token args
export const TOKEN_STANDARD_TO_PROTOCOL: Record<TokenStandard, ProtocolType> = {
  // EVM
  ERC20: ProtocolType.Ethereum,
  ERC721: ProtocolType.Ethereum,
  EvmNative: ProtocolType.Ethereum,
  EvmHypNative: ProtocolType.Ethereum,
  EvmHypCollateral: ProtocolType.Ethereum,
  EvmHypcollateralVault: ProtocolType.Ethereum,
  EvmHypSynthetic: ProtocolType.Ethereum,

  // Sealevel (Solana)
  SealevelSpl: ProtocolType.Sealevel,
  SealevelSpl2022: ProtocolType.Sealevel,
  SealevelNative: ProtocolType.Sealevel,
  SealevelHypNative: ProtocolType.Sealevel,
  SealevelHypCollateral: ProtocolType.Sealevel,
  SealevelHypSynthetic: ProtocolType.Sealevel,

  // Cosmos
  CosmosIcs20: ProtocolType.Cosmos,
  CosmosIcs721: ProtocolType.Cosmos,
  CosmosNative: ProtocolType.Cosmos,
  CosmosIbc: ProtocolType.Cosmos,

  // CosmWasm
  CW20: ProtocolType.Cosmos,
  CWNative: ProtocolType.Cosmos,
  CW721: ProtocolType.Cosmos,
  CwHypNative: ProtocolType.Cosmos,
  CwHypCollateral: ProtocolType.Cosmos,
  CwHypSynthetic: ProtocolType.Cosmos,

  // Fuel (TODO)
  FuelNative: ProtocolType.Fuel,
};

export const TOKEN_STANDARD_TO_PROVIDER_TYPE: Record<
  TokenStandard,
  ProviderType
> = objMap(TOKEN_STANDARD_TO_PROTOCOL, (k, v) => {
  if (k.startsWith('Cosmos')) return ProviderType.CosmJs;
  return PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[v];
});

export const TOKEN_NFT_STANDARDS = [
  TokenStandard.ERC721,
  TokenStandard.CosmosIcs721,
  TokenStandard.CW721,
  // TODO solana here
];

export const TOKEN_COLLATERALIZED_STANDARDS = [
  TokenStandard.EvmHypCollateral,
  TokenStandard.EvmHypNative,
  TokenStandard.SealevelHypCollateral,
  TokenStandard.SealevelHypNative,
  TokenStandard.CwHypCollateral,
  TokenStandard.CwHypNative,
];

export const TOKEN_HYP_STANDARDS = [
  TokenStandard.EvmHypNative,
  TokenStandard.EvmHypCollateral,
  TokenStandard.EvmHypSynthetic,
  TokenStandard.SealevelHypNative,
  TokenStandard.SealevelHypCollateral,
  TokenStandard.SealevelHypSynthetic,
  TokenStandard.CwHypNative,
  TokenStandard.CwHypCollateral,
  TokenStandard.CwHypSynthetic,
];

export const TOKEN_MULTI_CHAIN_STANDARDS = [
  ...TOKEN_HYP_STANDARDS,
  TokenStandard.CosmosIbc,
];

// Useful for differentiating from norma Cosmos standards
// (e.g. for determining the appropriate cosmos client)
export const TOKEN_COSMWASM_STANDARDS = [
  TokenStandard.CW20,
  TokenStandard.CWNative,
  TokenStandard.CW721,
  TokenStandard.CwHypNative,
  TokenStandard.CwHypCollateral,
  TokenStandard.CwHypSynthetic,
];

export const TOKEN_TYPE_TO_STANDARD: Record<TokenType, TokenStandard> = {
  [TokenType.native]: TokenStandard.EvmHypNative,
  [TokenType.collateral]: TokenStandard.EvmHypCollateral,
  [TokenType.collateralVault]: TokenStandard.EvmHypcollateralVault,
  [TokenType.collateralUri]: TokenStandard.EvmHypCollateral,
  [TokenType.fastCollateral]: TokenStandard.EvmHypCollateral,
  [TokenType.synthetic]: TokenStandard.EvmHypSynthetic,
  [TokenType.syntheticUri]: TokenStandard.EvmHypSynthetic,
  [TokenType.fastSynthetic]: TokenStandard.EvmHypSynthetic,
  [TokenType.nativeScaled]: TokenStandard.EvmHypNative,
};

export const PROTOCOL_TO_NATIVE_STANDARD: Record<ProtocolType, TokenStandard> =
  {
    [ProtocolType.Ethereum]: TokenStandard.EvmNative,
    [ProtocolType.Cosmos]: TokenStandard.CosmosNative,
    [ProtocolType.Sealevel]: TokenStandard.SealevelNative,
    [ProtocolType.Fuel]: TokenStandard.FuelNative,
  };
