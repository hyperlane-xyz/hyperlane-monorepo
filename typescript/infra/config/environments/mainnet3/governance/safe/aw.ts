import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// 2026-06-16: Commented-out entries are AW safes that own no warp routes and are
// not referenced as an owner by any monorepo config getter. They are retained
// (commented) for historical reference. With the proxy-admin / warp-router
// fallbacks, a missing entry resolves to the chain's governance owner / deployer
// rather than an unmaintained safe.
export const awSafes: ChainMap<Address> = {
  mantapacific: '0x03ed2D65f2742193CeD99D48EbF1F1D6F12345B6', // does not have a UI
  celo: '0x879038d6Fc9F6D5e2BA73188bd078486d77e1156',
  ethereum: '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6',
  avalanche: '0x5bE94B17112B8F18eA9Ac8e559377B467556a3c3',
  // polygon: '0xf9cFD440CfBCfAB8473cc156485B7eE753b2913E',
  bsc: '0x7bB2ADeDdC342ffb611dDC073095cc4B8C547170',
  arbitrum: '0x03fD5BE9DF85F0017dC7F4DC3068dDF64fffF25e',
  optimism: '0xbd7db3821806bc72D223F0AE521Bf82FcBd6Ef4d',
  // gnosis: '0x0Ac72fBc82c9c39F81242229631dfC38aA13031B',
  base: '0x3949eD0CD036D9FF662d97BD7aC1686051c4aeBF',
  // solana: 'EzppBFV2taxWw8kEjxNYvby6q7W1biJEqwP3iC7YgRe3',
  // blast: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  // linea: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  mode: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  // ancient8: '0xD2BFA0F0654E3f2139b8cDC56c32eeC54D32b133',
  // taiko: '0xa4864301d3fa2a3e68256309F9F0F570270a1BD0',
  // fraxtal: '0x66e9f52800E9F89F0569fddc594Acd5EE609f762',
  // sei: '0xCed197FBc360C26C19889745Cf73511b71D03d5D',
  // mantle: '0x8aFE6EECc6CcB02aA20DA8Fff7d29aadEBbc2DCd',
  // bob: '0x9e2fe7723b018d02cDE4f5cC1A9bC9C65b922Fc8',
  // zetachain: '0x9d399876522Fc5C044D048594de399A2349d6026',
  // fusemainnet: '0x29a526227CB864C90Cf078d03872da913B473139',
  // endurance: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  // zircuit: '0x9e2fe7723b018d02cDE4f5cC1A9bC9C65b922Fc8',
  // swell: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',

  // Q5, 2024 batch
  // berachain: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',

  // HyperEVM
  hyperevm: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',

  // zksync chains
  zeronetwork: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',
  // abstract: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',
  // zksync: '0x9C81aA0cC233e9BddeA426F5d395Ab5B65135450',
  // sophon: '0x3D1baf8cA4935f416671640B1Aa9E17E005986eE',

  // ousdt extension
  worldchain: '0x95b1634566663117322999ce42cDEaEF18c089Be',
  // unichain: '0x028C71E99e23fD393DE4207486D1aF7FA2b26b33',
  // ink: '0x8DEe31BF7da558ee3224D22E224e172783CA8d70',
  // soneium: '0xD97F1bc0d49f994137Acf36baE2aEd9b2E4F239a',
  // superseed: '0x2915Ff7B025bc65bBFfD1621F6B3d4E4295dB4F6',
  // lisk: '0x831d0b06DF466263c06FFcD467cf91c6FA57c62C',
  // sonic: '0x7f56412491D8E77331Ff0300d3C8E42A6D233FdC',
  // bitlayer: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',
  // ronin: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',
  // metis: '0xf6B817Cf8b4440F38951851cf1160969039966A2',
  // metal: '0x41A4e3425c7FeE8711D1C1b2c2acc1879F849b45',

  // Jan 29, 2026 - Migrating Viction to Safes
  // ----------------------------------------------------------
  viction: '0x18165B1cb2969B79D2a0f67AECe0bf7bb44a7CaD',

  // Feb 4, 2026 - FPWR ProxyAdmin on Safes
  // ----------------------------------------------------------
  // monad: '0x930f79e486B869EC7B5BF4e83121aDfcca198f42',

  // Mar 12, 2026 - Igra Chain Deployment
  // ----------------------------------------------------------
  // igra: '0x0c205894f0cA786AB1693f232F4e19a60Af5c72B',

  // Mar 24, 2026
  // ----------------------------------------------------------
  plasma: '0xCcf5e9862D486e71aA47B87Cb3a7eEB1e1f2F624',
};
