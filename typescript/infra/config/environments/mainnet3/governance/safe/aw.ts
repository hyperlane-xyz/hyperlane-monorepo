import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// Active AbacusWorks safes: own warp routes and/or are referenced as an owner by
// monorepo config (proxy-admin / warp-router config). Verified against on-chain
// proxy-admin owner() where applicable.
//
// Inactive safes (own no warp routes and not referenced as an owner anywhere) are
// commented out at the bottom — see the dated note there.
export const awSafes: ChainMap<Address> = {
  arbitrum: '0x03fD5BE9DF85F0017dC7F4DC3068dDF64fffF25e',
  avalanche: '0x5bE94B17112B8F18eA9Ac8e559377B467556a3c3',
  base: '0x3949eD0CD036D9FF662d97BD7aC1686051c4aeBF',
  bsc: '0x7bB2ADeDdC342ffb611dDC073095cc4B8C547170',
  celo: '0x879038d6Fc9F6D5e2BA73188bd078486d77e1156',
  ethereum: '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6',
  hyperevm: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',
  mantapacific: '0x03ed2D65f2742193CeD99D48EbF1F1D6F12345B6', // does not have safe API > 5.18.0
  mode: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  optimism: '0xbd7db3821806bc72D223F0AE521Bf82FcBd6Ef4d',
  plasma: '0xCcf5e9862D486e71aA47B87Cb3a7eEB1e1f2F624',
  viction: '0x18165B1cb2969B79D2a0f67AECe0bf7bb44a7CaD',
  worldchain: '0x95b1634566663117322999ce42cDEaEF18c089Be',
  zeronetwork: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',

  // ---------------------------------------------------------------------------
  // 2026-06-16: Inactive — own no warp routes and are not referenced as an owner
  // by any monorepo config getter. Retained for historical reference; a missing
  // entry resolves (via proxy-admin / warp-router fallbacks) to the chain's
  // governance owner rather than an unmaintained safe.
  // ---------------------------------------------------------------------------
  // abstract: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',
  // ancient8: '0xD2BFA0F0654E3f2139b8cDC56c32eeC54D32b133',
  // berachain: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',
  // bitlayer: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',
  // blast: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  // bob: '0x9e2fe7723b018d02cDE4f5cC1A9bC9C65b922Fc8',
  // endurance: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  // fraxtal: '0x66e9f52800E9F89F0569fddc594Acd5EE609f762',
  // fusemainnet: '0x29a526227CB864C90Cf078d03872da913B473139',
  // gnosis: '0x0Ac72fBc82c9c39F81242229631dfC38aA13031B',
  // igra: '0x0c205894f0cA786AB1693f232F4e19a60Af5c72B',
  // ink: '0x8DEe31BF7da558ee3224D22E224e172783CA8d70',
  // linea: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  // lisk: '0x831d0b06DF466263c06FFcD467cf91c6FA57c62C',
  // mantle: '0x8aFE6EECc6CcB02aA20DA8Fff7d29aadEBbc2DCd',
  // metal: '0x41A4e3425c7FeE8711D1C1b2c2acc1879F849b45',
  // metis: '0xf6B817Cf8b4440F38951851cf1160969039966A2',
  // monad: '0x930f79e486B869EC7B5BF4e83121aDfcca198f42',
  // polygon: '0xf9cFD440CfBCfAB8473cc156485B7eE753b2913E',
  // ronin: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',
  // sei: '0xCed197FBc360C26C19889745Cf73511b71D03d5D',
  // solana: 'EzppBFV2taxWw8kEjxNYvby6q7W1biJEqwP3iC7YgRe3',
  // soneium: '0xD97F1bc0d49f994137Acf36baE2aEd9b2E4F239a',
  // sonic: '0x7f56412491D8E77331Ff0300d3C8E42A6D233FdC',
  // sophon: '0x3D1baf8cA4935f416671640B1Aa9E17E005986eE',
  // superseed: '0x2915Ff7B025bc65bBFfD1621F6B3d4E4295dB4F6',
  // swell: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',
  // taiko: '0xa4864301d3fa2a3e68256309F9F0F570270a1BD0',
  // unichain: '0x028C71E99e23fD393DE4207486D1aF7FA2b26b33',
  // zetachain: '0x9d399876522Fc5C044D048594de399A2349d6026',
  // zircuit: '0x9e2fe7723b018d02cDE4f5cC1A9bC9C65b922Fc8',
  // zksync: '0x9C81aA0cC233e9BddeA426F5d395Ab5B65135450',
};
