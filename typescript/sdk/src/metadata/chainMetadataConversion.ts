import type { AssetList, Chain as CosmosChain } from '@chain-registry/types';
import { Chain, defineChain } from 'viem';

import { test1 } from '../consts/testChains.js';
import {
  ChainMetadata,
  getChainIdNumber,
} from '../metadata/chainMetadataTypes.js';

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
