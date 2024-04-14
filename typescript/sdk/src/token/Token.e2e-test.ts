/* eslint-disable no-console */
import { expect } from 'chai';
import { ethers } from 'ethers';

import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata.js';
import { Chains } from '../consts/chains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

import { TokenArgs } from './IToken.js';
import { Token } from './Token.js';
import { TokenStandard } from './TokenStandard.js';

// null values represent TODOs here, ideally all standards should be tested
const STANDARD_TO_TOKEN: Record<TokenStandard, TokenArgs | null> = {
  // EVM
  [TokenStandard.ERC20]: {
    chainName: Chains.ethereum,
    standard: TokenStandard.ERC20,
    addressOrDenom: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.ERC721]: null,
  [TokenStandard.EvmNative]: Token.FromChainMetadataNativeToken(
    chainMetadata.optimism,
  ),
  [TokenStandard.EvmHypNative]: {
    chainName: Chains.inevm,
    standard: TokenStandard.EvmHypNative,
    addressOrDenom: '0x26f32245fCF5Ad53159E875d5Cae62aEcf19c2d4',
    decimals: 18,
    symbol: 'INJ',
    name: 'Injective Coin',
  },
  [TokenStandard.EvmHypCollateral]: {
    chainName: Chains.bsctestnet,
    standard: TokenStandard.EvmHypCollateral,
    addressOrDenom: '0x31b5234A896FbC4b3e2F7237592D054716762131',
    collateralAddressOrDenom: '0x64544969ed7ebf5f083679233325356ebe738930',
    decimals: 18,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypcollateralVault]: {
    chainName: Chains.bsctestnet,
    standard: TokenStandard.EvmHypCollateral,
    addressOrDenom: '0x31b5234A896FbC4b3e2F7237592D054716762131',
    collateralAddressOrDenom: '0x64544969ed7ebf5f083679233325356ebe738930',
    decimals: 18,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypSynthetic]: {
    chainName: Chains.inevm,
    standard: TokenStandard.EvmHypSynthetic,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },

  // Sealevel
  [TokenStandard.SealevelSpl]: {
    chainName: Chains.solana,
    standard: TokenStandard.SealevelSpl,
    addressOrDenom: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'Wrapped SOL',
    name: 'SOL',
  },
  [TokenStandard.SealevelSpl2022]: {
    chainName: Chains.solana,
    standard: TokenStandard.SealevelSpl2022,
    addressOrDenom: '21zHSATJqhNkcpoNkhFzPJW9LARSmoinLEeDtdygGuWh',
    decimals: 6,
    symbol: 'SOLMAX',
    name: 'Solana Maxi',
  },
  [TokenStandard.SealevelNative]: Token.FromChainMetadataNativeToken(
    chainMetadata.solana,
  ),
  [TokenStandard.SealevelHypNative]: null,
  [TokenStandard.SealevelHypCollateral]: null,
  [TokenStandard.SealevelHypSynthetic]: null,

  // Cosmos
  [TokenStandard.CosmosIcs20]: null,
  [TokenStandard.CosmosIcs721]: null,
  [TokenStandard.CosmosNative]: Token.FromChainMetadataNativeToken(
    chainMetadata.neutron,
  ),
  [TokenStandard.CosmosIbc]: {
    chainName: Chains.neutron,
    standard: TokenStandard.CosmosIbc,
    addressOrDenom:
      'ibc/773B4D0A3CD667B2275D5A4A7A2F0909C0BA0F4059C0B9181E680DDF4965DCC7',
    decimals: 6,
    symbol: 'TIA',
    name: 'TIA',
  },
  [TokenStandard.CW20]: null,
  [TokenStandard.CWNative]: {
    chainName: Chains.neutron,
    standard: TokenStandard.CWNative,
    addressOrDenom:
      'ibc/5751B8BCDA688FD0A8EC0B292EEF1CDEAB4B766B63EC632778B196D317C40C3A',
    decimals: 6,
    symbol: 'ASTRO',
    name: 'ASTRO',
  },
  [TokenStandard.CW721]: null,
  [TokenStandard.CwHypNative]: {
    chainName: Chains.injective,
    standard: TokenStandard.CwHypNative,
    addressOrDenom: 'inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k',
    igpTokenAddressOrDenom: 'inj',
    decimals: 18,
    symbol: 'INJ',
    name: 'Injective Coin',
  },
  [TokenStandard.CwHypCollateral]: {
    chainName: Chains.neutron,
    standard: TokenStandard.CwHypCollateral,
    addressOrDenom:
      'neutron1jyyjd3x0jhgswgm6nnctxvzla8ypx50tew3ayxxwkrjfxhvje6kqzvzudq',
    collateralAddressOrDenom:
      'ibc/773B4D0A3CD667B2275D5A4A7A2F0909C0BA0F4059C0B9181E680DDF4965DCC7',
    decimals: 6,
    symbol: 'TIA.n',
    name: 'TIA.n',
  },
  [TokenStandard.CwHypSynthetic]: null,

  // Fuel
  [TokenStandard.FuelNative]: null,
};

const PROTOCOL_TO_ADDRESS: Partial<Record<ProtocolType, Address>> = {
  [ProtocolType.Ethereum]: ethers.constants.AddressZero,
  [ProtocolType.Cosmos]:
    'neutron13we0myxwzlpx8l5ark8elw5gj5d59dl6cjkzmt80c5q5cv5rt54qvzkv2a',
  [ProtocolType.Fuel]: '',
};

const STANDARD_TO_ADDRESS: Partial<Record<TokenStandard, Address>> = {
  [TokenStandard.SealevelSpl]: 'HVSZJ2juJnMxd6yCNarTL56YmgUqzfUiwM7y7LtTXKHR',
  [TokenStandard.SealevelSpl2022]:
    'EK6cs8jNnu2d9pmKTGf1Bvre9oW2xNhcCKNdLKx6t74w',
  [TokenStandard.SealevelNative]:
    'EK6cs8jNnu2d9pmKTGf1Bvre9oW2xNhcCKNdLKx6t74w',
  [TokenStandard.CwHypNative]: 'inj1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3lj7tt0',
};

describe('Token', () => {
  it('Handles all standards', async () => {
    const multiProvider = new MultiProtocolProvider();
    for (const tokenArgs of Object.values(STANDARD_TO_TOKEN)) {
      if (!tokenArgs) continue;
      console.debug('Testing token standard', tokenArgs.standard);
      const token = new Token(tokenArgs);
      expect(token.standard).to.eql(tokenArgs.standard);
      const adapter = token.getAdapter(multiProvider);
      const address =
        STANDARD_TO_ADDRESS[token.standard] ??
        PROTOCOL_TO_ADDRESS[token.protocol];
      if (!address)
        throw new Error(`No address for standard ${tokenArgs.standard}`);
      const balance = await adapter.getBalance(address);
      expect(typeof balance).to.eql('bigint');
    }
  })
    .timeout(120_000)
    .retries(3);

  it('Constructs from ChainMetadata', () => {
    for (const metadata of Object.values(chainMetadata)) {
      if (!metadata.nativeToken) continue;
      const token = Token.FromChainMetadataNativeToken(metadata);
      expect(token.symbol).to.eql(metadata.nativeToken.symbol);
    }
  });
});
