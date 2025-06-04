/* eslint-disable no-console */
import { SystemProgram } from '@solana/web3.js';
import { expect } from 'chai';
import { ethers } from 'ethers';

import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import {
  TestChainName,
  test1,
  testCosmosChain,
  testSealevelChain,
} from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { stubMultiProtocolProvider } from '../test/multiProviderStubs.js';

import { TokenArgs } from './IToken.js';
import { Token } from './Token.js';
import { TokenStandard } from './TokenStandard.js';

// null values represent TODOs here, ideally all standards should be tested
const STANDARD_TO_TOKEN: Record<TokenStandard, TokenArgs | null> = {
  // EVM
  [TokenStandard.ERC20]: {
    chainName: TestChainName.test1,
    standard: TokenStandard.ERC20,
    addressOrDenom: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.ERC721]: null,
  [TokenStandard.EvmNative]: Token.FromChainMetadataNativeToken(test1),
  [TokenStandard.EvmHypNative]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypNative,
    addressOrDenom: '0x26f32245fCF5Ad53159E875d5Cae62aEcf19c2d4',
    decimals: 18,
    symbol: 'INJ',
    name: 'Injective Coin',
  },
  [TokenStandard.EvmHypNativeMemo]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypNativeMemo,
    addressOrDenom: '0x26f32245fCF5Ad53159E875d5Cae62aEcf19c2d4', // TODO: check
    decimals: 18,
    symbol: 'INJ',
    name: 'Injective Coin',
  },
  [TokenStandard.EvmHypCollateral]: {
    chainName: TestChainName.test3,
    standard: TokenStandard.EvmHypCollateral,
    addressOrDenom: '0x31b5234A896FbC4b3e2F7237592D054716762131',
    collateralAddressOrDenom: '0x64544969ed7ebf5f083679233325356ebe738930',
    decimals: 18,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypCollateralMemo]: {
    chainName: TestChainName.test3,
    standard: TokenStandard.EvmHypCollateralMemo,
    addressOrDenom: '0x31b5234A896FbC4b3e2F7237592D054716762131', // TODO: check
    collateralAddressOrDenom: '0x64544969ed7ebf5f083679233325356ebe738930', // TODO: check
    decimals: 18,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypRebaseCollateral]: {
    chainName: TestChainName.test3,
    standard: TokenStandard.EvmHypRebaseCollateral,
    addressOrDenom: '0x31b5234A896FbC4b3e2F7237592D054716762131',
    collateralAddressOrDenom: '0x64544969ed7ebf5f083679233325356ebe738930',
    decimals: 18,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypOwnerCollateral]: {
    chainName: TestChainName.test3,
    standard: TokenStandard.EvmHypOwnerCollateral,
    addressOrDenom: '0x31b5234A896FbC4b3e2F7237592D054716762131',
    collateralAddressOrDenom: '0x64544969ed7ebf5f083679233325356ebe738930',
    decimals: 18,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypCollateralFiat]: {
    chainName: TestChainName.test3,
    standard: TokenStandard.EvmHypCollateralFiat,
    addressOrDenom: '0x31b5234A896FbC4b3e2F7237592D054716762131',
    collateralAddressOrDenom: '0x64544969ed7ebf5f083679233325356ebe738930',
    decimals: 18,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypSynthetic]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypSynthetic,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147', // TODO: check
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypSyntheticMemo]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypSyntheticMemo,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypSyntheticRebase]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypSyntheticRebase,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypXERC20]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypXERC20,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypXERC20Lockbox]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypXERC20Lockbox,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypVSXERC20]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypVSXERC20,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.EvmHypVSXERC20Lockbox]: {
    chainName: TestChainName.test2,
    standard: TokenStandard.EvmHypVSXERC20Lockbox,
    addressOrDenom: '0x8358D8291e3bEDb04804975eEa0fe9fe0fAfB147',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },

  // Sealevel
  [TokenStandard.SealevelSpl]: {
    chainName: testSealevelChain.name,
    standard: TokenStandard.SealevelSpl,
    addressOrDenom: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'Wrapped SOL',
    name: 'SOL',
  },
  [TokenStandard.SealevelSpl2022]: {
    chainName: testSealevelChain.name,
    standard: TokenStandard.SealevelSpl2022,
    addressOrDenom: '21zHSATJqhNkcpoNkhFzPJW9LARSmoinLEeDtdygGuWh',
    decimals: 6,
    symbol: 'SOLMAX',
    name: 'Solana Maxi',
  },
  [TokenStandard.SealevelNative]:
    Token.FromChainMetadataNativeToken(testSealevelChain),
  [TokenStandard.SealevelHypNative]: {
    chainName: testSealevelChain.name,
    standard: TokenStandard.SealevelHypNative,
    addressOrDenom: '4UMNyNWW75zo69hxoJaRX5iXNUa5FdRPZZa9vDVCiESg',
    decimals: 9,
    symbol: 'SOL',
    name: 'SOL',
  },
  [TokenStandard.SealevelHypCollateral]: {
    chainName: testSealevelChain.name,
    standard: TokenStandard.SealevelHypCollateral,
    addressOrDenom: 'Fefw54S6NDdwNbPngPePvW4tiFTFQDT7gBPvFoDFeGqg',
    collateralAddressOrDenom: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  [TokenStandard.SealevelHypSynthetic]: {
    chainName: testSealevelChain.name,
    standard: TokenStandard.SealevelHypSynthetic,
    addressOrDenom: 'GLpdg3jt6w4eVYiCMhokVZ4mX6hmRvPhcL5RoCjzGr5k',
    collateralAddressOrDenom: '8SuhHnSEogAN2udZsoychjTafnaGgM9MCidYZEP8vuVY',
    decimals: 9,
    symbol: 'SOL',
    name: 'SOL',
  },

  // Cosmos
  [TokenStandard.CosmosIcs20]: null,
  [TokenStandard.CosmosIcs721]: null,
  [TokenStandard.CosmosNative]:
    Token.FromChainMetadataNativeToken(testCosmosChain),
  [TokenStandard.CosmosIbc]: {
    chainName: testCosmosChain.name,
    standard: TokenStandard.CosmosIbc,
    addressOrDenom:
      'ibc/773B4D0A3CD667B2275D5A4A7A2F0909C0BA0F4059C0B9181E680DDF4965DCC7',
    decimals: 6,
    symbol: 'TIA',
    name: 'TIA',
  },
  [TokenStandard.CW20]: null,
  [TokenStandard.CWNative]: {
    chainName: testCosmosChain.name,
    standard: TokenStandard.CWNative,
    addressOrDenom:
      'ibc/5751B8BCDA688FD0A8EC0B292EEF1CDEAB4B766B63EC632778B196D317C40C3A',
    decimals: 6,
    symbol: 'ASTRO',
    name: 'ASTRO',
  },
  [TokenStandard.CW721]: null,
  [TokenStandard.CwHypNative]: {
    chainName: testCosmosChain.name,
    standard: TokenStandard.CwHypNative,
    addressOrDenom: 'inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k',
    igpTokenAddressOrDenom: 'inj',
    decimals: 18,
    symbol: 'INJ',
    name: 'Injective Coin',
  },
  [TokenStandard.CwHypCollateral]: {
    chainName: testCosmosChain.name,
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

  [TokenStandard.CosmNativeHypCollateral]: null,
  [TokenStandard.CosmNativeHypSynthetic]: null,

  //TODO: check this and manage it.
  [TokenStandard.StarknetHypCollateral]: null,
  [TokenStandard.StarknetHypNative]: null,
  [TokenStandard.StarknetHypSynthetic]: null,
};

const PROTOCOL_TO_ADDRESS_FOR_BALANCE_CHECK: Partial<
  Record<ProtocolType, Address>
> = {
  [ProtocolType.Ethereum]: ethers.constants.AddressZero,
  [ProtocolType.Cosmos]:
    'neutron13we0myxwzlpx8l5ark8elw5gj5d59dl6cjkzmt80c5q5cv5rt54qvzkv2a',
  [ProtocolType.Sealevel]: 'EK6cs8jNnu2d9pmKTGf1Bvre9oW2xNhcCKNdLKx6t74w',
};

const STANDARD_TO_ADDRESS_FOR_BALANCE_CHECK: Partial<
  Record<TokenStandard, Address>
> = {
  [TokenStandard.SealevelSpl]: 'HVSZJ2juJnMxd6yCNarTL56YmgUqzfUiwM7y7LtTXKHR',
  [TokenStandard.CwHypNative]: 'inj1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3lj7tt0',
};

describe('Token', () => {
  for (const tokenArgs of Object.values(STANDARD_TO_TOKEN)) {
    if (!tokenArgs) continue;
    it(`Handles ${tokenArgs.standard} standard`, async () => {
      const multiProvider =
        MultiProtocolProvider.createTestMultiProtocolProvider<{
          mailbox?: string;
        }>();
      // A placeholder mailbox address for the sealevel chain
      multiProvider.metadata[testSealevelChain.name].mailbox =
        SystemProgram.programId.toBase58();

      console.debug('Testing token standard', tokenArgs.standard);
      const token = new Token(tokenArgs);
      expect(token.standard).to.eql(tokenArgs.standard);
      const adapter = token.getAdapter(multiProvider);
      const balanceCheckAddress =
        STANDARD_TO_ADDRESS_FOR_BALANCE_CHECK[token.standard] ??
        PROTOCOL_TO_ADDRESS_FOR_BALANCE_CHECK[token.protocol];
      if (!balanceCheckAddress)
        throw new Error(`No address for standard ${tokenArgs.standard}`);

      const sandbox = stubMultiProtocolProvider(multiProvider);
      // @ts-ignore simple extra mock for the Ethers V5 token contract call
      adapter.contract = {
        balanceOf: async () => '100',
      };

      const balance = await adapter.getBalance(balanceCheckAddress);
      expect(typeof balance).to.eql('bigint');
      sandbox.restore();
    });
  }
});
