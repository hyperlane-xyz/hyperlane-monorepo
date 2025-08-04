import { ProtocolType, assert, objMap } from '@hyperlane-xyz/utils';

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
  EvmHypOwnerCollateral = 'EvmHypOwnerCollateral',
  EvmHypRebaseCollateral = 'EvmHypRebaseCollateral',
  EvmHypCollateralFiat = 'EvmHypCollateralFiat',
  EvmHypSynthetic = 'EvmHypSynthetic',
  EvmHypSyntheticRebase = 'EvmHypSyntheticRebase',
  EvmHypXERC20 = 'EvmHypXERC20',
  EvmHypXERC20Lockbox = 'EvmHypXERC20Lockbox',
  EvmHypVSXERC20 = 'EvmHypVSXERC20',
  EvmHypVSXERC20Lockbox = 'EvmHypVSXERC20Lockbox',
  EvmM0PortalLite = 'EvmM0PortalLite',
  EvmHypEverclearCollateral = 'EvmHypEverclearCollateral',
  EvmHypEverclearEth = 'EvmHypEverclearEth',

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

  // Cosmos Native
  CosmNativeHypCollateral = 'CosmosNativeHypCollateral',
  CosmNativeHypSynthetic = 'CosmosNativeHypSynthetic',

  // Starknet
  StarknetNative = 'StarknetNative',
  StarknetHypNative = 'StarknetHypNative',
  StarknetHypCollateral = 'StarknetHypCollateral',
  StarknetHypSynthetic = 'StarknetHypSynthetic',

  // Radix
  RadixNative = 'RadixNative',
  RadixHypCollateral = 'RadixHypCollateral',
  RadixHypSynthetic = 'RadixHypSynthetic',

  // Sovereign
  SovBank = 'SovBank',
  SovBankNative = 'SovBankNative',
  SovHypNative = 'SovHypNative',
  SovHypCollateral = 'SovHypCollateral',
  SovHypSynthetic = 'SovHypSynthetic',
}

// Allows for omission of protocol field in token args
export const TOKEN_STANDARD_TO_PROTOCOL: Record<TokenStandard, ProtocolType> = {
  // EVM
  ERC20: ProtocolType.Ethereum,
  ERC721: ProtocolType.Ethereum,
  EvmNative: ProtocolType.Ethereum,
  EvmHypNative: ProtocolType.Ethereum,
  EvmHypCollateral: ProtocolType.Ethereum,
  EvmHypOwnerCollateral: ProtocolType.Ethereum,
  EvmHypRebaseCollateral: ProtocolType.Ethereum,
  EvmHypCollateralFiat: ProtocolType.Ethereum,
  EvmHypSynthetic: ProtocolType.Ethereum,
  EvmHypSyntheticRebase: ProtocolType.Ethereum,
  EvmHypXERC20: ProtocolType.Ethereum,
  EvmHypXERC20Lockbox: ProtocolType.Ethereum,
  EvmHypVSXERC20: ProtocolType.Ethereum,
  EvmHypVSXERC20Lockbox: ProtocolType.Ethereum,
  EvmM0PortalLite: ProtocolType.Ethereum,
  [TokenStandard.EvmHypEverclearCollateral]: ProtocolType.Ethereum,
  [TokenStandard.EvmHypEverclearEth]: ProtocolType.Ethereum,

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

  // Cosmos Native
  CosmosNativeHypCollateral: ProtocolType.CosmosNative,
  CosmosNativeHypSynthetic: ProtocolType.CosmosNative,

  // CosmWasm
  CW20: ProtocolType.Cosmos,
  CWNative: ProtocolType.Cosmos,
  CW721: ProtocolType.Cosmos,
  CwHypNative: ProtocolType.Cosmos,
  CwHypCollateral: ProtocolType.Cosmos,
  CwHypSynthetic: ProtocolType.Cosmos,

  // Starknet
  StarknetNative: ProtocolType.Starknet,
  StarknetHypCollateral: ProtocolType.Starknet,
  StarknetHypNative: ProtocolType.Starknet,
  StarknetHypSynthetic: ProtocolType.Starknet,

  // Radix
  RadixNative: ProtocolType.Radix,
  RadixHypCollateral: ProtocolType.Radix,
  RadixHypSynthetic: ProtocolType.Radix,

  // Sovereign
  SovBank: ProtocolType.Sovereign,
  SovBankNative: ProtocolType.Sovereign,
  SovHypNative: ProtocolType.Sovereign,
  SovHypCollateral: ProtocolType.Sovereign,
  SovHypSynthetic: ProtocolType.Sovereign,
};

export const TOKEN_STANDARD_TO_PROVIDER_TYPE: Record<
  TokenStandard,
  ProviderType
> = objMap(TOKEN_STANDARD_TO_PROTOCOL, (k, v) => {
  if (k.startsWith('CosmosNative')) {
    return ProviderType.CosmJsNative;
  }
  if (k.startsWith('Cosmos')) {
    return ProviderType.CosmJs;
  }

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
  TokenStandard.CosmNativeHypCollateral,
  TokenStandard.EvmHypXERC20Lockbox,
  TokenStandard.EvmHypVSXERC20Lockbox,
];

export const XERC20_STANDARDS = [
  TokenStandard.EvmHypXERC20,
  TokenStandard.EvmHypXERC20Lockbox,
  TokenStandard.EvmHypVSXERC20,
  TokenStandard.EvmHypVSXERC20Lockbox,
];

export const LOCKBOX_STANDARDS = [
  TokenStandard.EvmHypXERC20Lockbox,
  TokenStandard.EvmHypVSXERC20Lockbox,
];

export const MINT_LIMITED_STANDARDS = [
  TokenStandard.EvmHypXERC20,
  TokenStandard.EvmHypXERC20Lockbox,
  TokenStandard.EvmHypVSXERC20,
  TokenStandard.EvmHypVSXERC20Lockbox,
  TokenStandard.EvmHypCollateralFiat,
];

export const TOKEN_HYP_STANDARDS = [
  TokenStandard.EvmHypNative,
  TokenStandard.EvmHypCollateral,
  TokenStandard.EvmHypCollateralFiat,
  TokenStandard.EvmHypOwnerCollateral,
  TokenStandard.EvmHypRebaseCollateral,
  TokenStandard.EvmHypSynthetic,
  TokenStandard.EvmHypSyntheticRebase,
  TokenStandard.EvmHypXERC20,
  TokenStandard.EvmHypXERC20Lockbox,
  TokenStandard.EvmHypVSXERC20,
  TokenStandard.EvmHypVSXERC20Lockbox,
  TokenStandard.EvmM0PortalLite,
  TokenStandard.SealevelHypNative,
  TokenStandard.SealevelHypCollateral,
  TokenStandard.SealevelHypSynthetic,
  TokenStandard.CwHypNative,
  TokenStandard.CwHypCollateral,
  TokenStandard.CwHypSynthetic,
  TokenStandard.CosmNativeHypCollateral,
  TokenStandard.CosmNativeHypSynthetic,
  TokenStandard.StarknetHypNative,
  TokenStandard.StarknetHypCollateral,
  TokenStandard.StarknetHypSynthetic,
  TokenStandard.RadixHypCollateral,
  TokenStandard.RadixHypSynthetic,
  TokenStandard.SovHypNative,
  TokenStandard.SovHypCollateral,
  TokenStandard.SovHypSynthetic,
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

export const tokenTypeToStandard = (
  protocolType: ProtocolType,
  tokenType: TokenType,
) => {
  switch (protocolType) {
    case ProtocolType.Ethereum: {
      return EVM_TOKEN_TYPE_TO_STANDARD[tokenType];
    }
    case ProtocolType.CosmosNative: {
      if (
        COSMOS_NATIVE_SUPPORTED_TOKEN_TYPES.includes(
          tokenType as CosmosNativeSupportedTokenTypes,
        )
      ) {
        return COSMOS_NATIVE_TOKEN_TYPE_TO_STANDARD[
          tokenType as CosmosNativeSupportedTokenTypes
        ];
      }

      throw new Error(
        `token type ${tokenType} not available on protocol ${protocolType}`,
      );
    }
    case ProtocolType.Radix: {
      if (
        RADIX_SUPPORTED_TOKEN_TYPES.includes(
          tokenType as RadixSupportedTokenTypes,
        )
      ) {
        return RADIX_TOKEN_TYPE_TO_STANDARD[
          tokenType as RadixSupportedTokenTypes
        ];
      }

      throw new Error(
        `token type ${tokenType} not available on protocol ${protocolType}`,
      );
    }
    case ProtocolType.Sealevel: {
      const sealevelTokenStandard =
        SEALEVEL_TOKEN_TYPE_TO_STANDARD[
          tokenType as SealevelSupportedTokenTypes
        ];

      assert(
        sealevelTokenStandard,
        `token type ${tokenType} not available on protocol ${protocolType}`,
      );
      return sealevelTokenStandard;
    }
    default: {
      throw new Error(
        `no token standard available for protocol type ${protocolType}`,
      );
    }
  }
};

export const EVM_TOKEN_TYPE_TO_STANDARD: Record<TokenType, TokenStandard> = {
  [TokenType.native]: TokenStandard.EvmHypNative,
  [TokenType.collateral]: TokenStandard.EvmHypCollateral,
  [TokenType.collateralFiat]: TokenStandard.EvmHypCollateralFiat,
  [TokenType.XERC20]: TokenStandard.EvmHypXERC20,
  [TokenType.XERC20Lockbox]: TokenStandard.EvmHypXERC20Lockbox,
  [TokenType.collateralVault]: TokenStandard.EvmHypOwnerCollateral,
  [TokenType.collateralVaultRebase]: TokenStandard.EvmHypRebaseCollateral,
  [TokenType.collateralUri]: TokenStandard.EvmHypCollateral,
  [TokenType.synthetic]: TokenStandard.EvmHypSynthetic,
  [TokenType.syntheticRebase]: TokenStandard.EvmHypSyntheticRebase,
  [TokenType.syntheticUri]: TokenStandard.EvmHypSynthetic,
  [TokenType.nativeScaled]: TokenStandard.EvmHypNative,
  [TokenType.collateralCctp]: TokenStandard.EvmHypCollateral,
  [TokenType.nativeOpL1]: TokenStandard.EvmHypNative,
  [TokenType.nativeOpL2]: TokenStandard.EvmHypNative,
  [TokenType.ethEverclear]: TokenStandard.EvmHypEverclearEth,
  [TokenType.collateralEverclear]: TokenStandard.EvmHypEverclearCollateral,
};

// Cosmos Native supported token types
export const COSMOS_NATIVE_SUPPORTED_TOKEN_TYPES = [
  TokenType.collateral,
  TokenType.synthetic,
] as const;

type CosmosNativeSupportedTokenTypes =
  (typeof COSMOS_NATIVE_SUPPORTED_TOKEN_TYPES)[number];

export const COSMOS_NATIVE_TOKEN_TYPE_TO_STANDARD: Record<
  CosmosNativeSupportedTokenTypes,
  TokenStandard
> = {
  [TokenType.collateral]: TokenStandard.CosmNativeHypCollateral,
  [TokenType.synthetic]: TokenStandard.CosmNativeHypSynthetic,
};

// Sealevel supported token types
export const SEALEVEL_SUPPORTED_TOKEN_TYPES = [
  TokenType.collateral,
  TokenType.synthetic,
  TokenType.native,
] as const;

type SealevelSupportedTokenTypes =
  (typeof SEALEVEL_SUPPORTED_TOKEN_TYPES)[number];

export const SEALEVEL_TOKEN_TYPE_TO_STANDARD: Record<
  SealevelSupportedTokenTypes,
  TokenStandard
> = {
  [TokenType.collateral]: TokenStandard.SealevelHypCollateral,
  [TokenType.synthetic]: TokenStandard.SealevelHypSynthetic,
  [TokenType.native]: TokenStandard.SealevelHypNative,
};

// Starknet supported token types
export const STARKNET_SUPPORTED_TOKEN_TYPES = [
  TokenType.collateral,
  TokenType.native,
  TokenType.synthetic,
] as const;

type StarknetSupportedTokenTypes =
  (typeof STARKNET_SUPPORTED_TOKEN_TYPES)[number];

export const STARKNET_TOKEN_TYPE_TO_STANDARD: Record<
  StarknetSupportedTokenTypes,
  TokenStandard
> = {
  [TokenType.collateral]: TokenStandard.StarknetHypCollateral,
  [TokenType.native]: TokenStandard.StarknetHypNative,
  [TokenType.synthetic]: TokenStandard.StarknetHypSynthetic,
};

export const RADIX_SUPPORTED_TOKEN_TYPES = [
  TokenType.collateral,
  TokenType.synthetic,
] as const;

type RadixSupportedTokenTypes = (typeof RADIX_SUPPORTED_TOKEN_TYPES)[number];

export const RADIX_TOKEN_TYPE_TO_STANDARD: Record<
  RadixSupportedTokenTypes,
  TokenStandard
> = {
  [TokenType.collateral]: TokenStandard.RadixHypCollateral,
  [TokenType.synthetic]: TokenStandard.RadixHypSynthetic,
};

export const PROTOCOL_TO_NATIVE_STANDARD: Record<ProtocolType, TokenStandard> =
  {
    [ProtocolType.Ethereum]: TokenStandard.EvmNative,
    [ProtocolType.Cosmos]: TokenStandard.CosmosNative,
    [ProtocolType.CosmosNative]: TokenStandard.CosmosNative,
    [ProtocolType.Sealevel]: TokenStandard.SealevelNative,
    [ProtocolType.Starknet]: TokenStandard.StarknetNative,
    [ProtocolType.Radix]: TokenStandard.RadixNative,
    [ProtocolType.Sovereign]: TokenStandard.SovBankNative,
  };

export const PROTOCOL_TO_HYP_NATIVE_STANDARD: Record<
  ProtocolType,
  TokenStandard
> = {
  [ProtocolType.Ethereum]: TokenStandard.EvmHypNative,
  [ProtocolType.Cosmos]: TokenStandard.CwHypNative,
  [ProtocolType.Sealevel]: TokenStandard.SealevelHypNative,
  [ProtocolType.Starknet]: TokenStandard.StarknetHypNative,
  // collateral and native are the same for cosmosnative and radix
  [ProtocolType.Radix]: TokenStandard.RadixHypCollateral,
  [ProtocolType.CosmosNative]: TokenStandard.CosmNativeHypCollateral,
  [ProtocolType.Sovereign]: TokenStandard.SovHypNative,
};
