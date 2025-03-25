import type { AssetList, Chain as CosmosChain } from '@chain-registry/types';
import { Chain as StarknetChain } from '@starknet-react/chains';
import { Chain, defineChain } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { test1 } from '../consts/testChains.js';
import {
  ChainMetadata,
  getChainIdNumber,
} from '../metadata/chainMetadataTypes.js';
import { PROTOCOL_TO_DEFAULT_NATIVE_TOKEN } from '../token/nativeTokenMetadata.js';

export function chainMetadataToViemChain(metadata: ChainMetadata): Chain {
  return defineChain({
    id: getChainIdNumber(metadata),
    name: metadata.displayName || metadata.name,
    network: metadata.name,
    nativeCurrency: metadata.nativeToken || test1.nativeToken!,
    rpcUrls: {
      public: { http: [metadata.rpcUrls[0].http] },
      default: { http: [metadata.rpcUrls[0].http] },
    },
    blockExplorers: metadata.blockExplorers?.length
      ? {
          default: {
            name: metadata.blockExplorers[0].name,
            url: metadata.blockExplorers[0].url,
          },
        }
      : undefined,
    testnet: !!metadata.isTestnet,
  });
}

export function chainMetadataToCosmosChain(metadata: ChainMetadata): {
  chain: CosmosChain;
  assets: AssetList;
} {
  const {
    name,
    displayName,
    chainId,
    rpcUrls,
    restUrls,
    isTestnet,
    nativeToken,
    bech32Prefix,
    slip44,
  } = metadata;

  if (!nativeToken) throw new Error(`Missing native token for ${name}`);

  const chain: CosmosChain = {
    chain_name: name,
    chain_type: 'cosmos',
    status: 'live',
    network_type: isTestnet ? 'testnet' : 'mainnet',
    pretty_name: displayName || name,
    chain_id: chainId as string,
    bech32_prefix: bech32Prefix!,
    slip44: slip44!,
    apis: {
      rpc: [{ address: rpcUrls[0].http, provider: displayName || name }],
      rest: restUrls
        ? [{ address: restUrls[0].http, provider: displayName || name }]
        : [],
    },
    fees: {
      fee_tokens: [{ denom: 'token' }],
    },
    staking: {
      staking_tokens: [{ denom: 'stake' }],
    },
  };

  const assets: AssetList = {
    chain_name: name,
    assets: [
      {
        description: `The native token of ${displayName || name} chain.`,
        denom_units: [{ denom: 'token', exponent: nativeToken.decimals }],
        base: 'token',
        name: 'token',
        display: 'token',
        symbol: 'token',
        type_asset: 'sdk.coin',
      },
      {
        description: `The native token of ${displayName || name} chain.`,
        denom_units: [{ denom: 'token', exponent: nativeToken.decimals }],
        base: 'stake',
        name: 'stake',
        display: 'stake',
        symbol: 'stake',
        type_asset: 'sdk.coin',
      },
    ],
  };

  return { chain, assets };
}

export function chainMetadataToStarknetChain(
  metadata: ChainMetadata,
): StarknetChain {
  const httpUrls = metadata.rpcUrls
    .map((url) => {
      if (typeof url.http === 'string') {
        return url.http;
      }
      return null;
    })
    .filter((url): url is string => url !== null);

  return {
    id: BigInt(metadata.chainId),
    name: metadata.name,
    network: metadata.name.toLowerCase(),
    nativeCurrency: {
      name: metadata.nativeToken?.name || 'Ether',
      symbol: metadata.nativeToken?.symbol || 'ETH',
      decimals: metadata.nativeToken?.decimals || 18,
      address:
        (metadata.nativeToken?.denom as `0x${string}`) ??
        PROTOCOL_TO_DEFAULT_NATIVE_TOKEN[ProtocolType.Starknet].denom,
    },
    testnet: metadata.isTestnet,
    rpcUrls: {
      default: {
        http: httpUrls,
      },
      public: {
        http: httpUrls,
      },
    },
  };
}
