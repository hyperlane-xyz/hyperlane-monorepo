// Found by running:
import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// REGISTRY_URI=/Users/pbio/work/tmpauditq2/hyperlane-registry \
// pnpm tsx scripts/keys/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --deploy \
// --governanceType abacusWorks
// -c <chain1> <chain2> ... \
export const awIcas: ChainMap<Address> = {
  // owner chain
  // ethereum: '0x24c2160941cB0A75E1C2aA6B70Be3e6EC4FE3a29',

  // keep safe-owned for now
  // optimism: '0x1E2afA8d1B841c53eDe9474D188Cd4FcfEd40dDC',

  // Jul 2, 2025 - ICA 2.0 Migration
  // ----------------------------------------------------------
  apechain: '0x4745601a50CEE53b66221032318a2547D5741ae8',
  appchain: '0xA843bFe58EbffaDc274b6718b238d60141E1281b',
  arbitrum: '0xD2757Bbc28C80789Ed679f22Ac65597Cacf51A45',
  arcadia: '0x2616bb811BBE23A85D828d0732C170aC29ddf68A',
  botanix: '0x514A0b6B06941561c3A33ce78e4d46F006450C01',
  avalanche: '0xe9232de913DfB7AC5E3e8dC3c3f48e2b7480889D',
  base: '0x61756c4beBC1BaaC09d89729E2cbaD8BD30c62B7',
  berachain: '0x602C75F468df1AC861862D8fdBFdf5f08d8Bdb88',
  bitlayer: '0x2A59725D978616DebFc43f8136A0d6258bC23cc5',
  blast: '0xc242beF1ffd95C1b3B7e8d6bB87947d3ADb335Ad',
  bob: '0xcBbB0A004177f12672fF02837AEB25d04bE74621',
  boba: '0x1301a4D0E15ca5F595a0207aD7990B864E93469A',
  bsc: '0x269Af9E53192AF49a22ff47e30b89dE1375AE1fd',
  celo: '0x0691c077d180ca7615911b65DE4fA0B313d75aDd',
  coti: '0xBC6Fae7e5e18624F5892399BA29705e039E4c9fD',
  flowmainnet: '0x82fa5cB2e567248aD37CCd96b6Fc3111B8956293',
  fraxtal: '0x1f8f770c963b17721C0cb084c18b3a3166a8d659',
  galactica: '0x085DC299cB1ceB3d4b584b320bb07C074F6A7c8a',
  gnosis: '0x80224Ae676F55Be8dcaFA425aCEF89eAe8f73c22',
  hashkey: '0x28b830D48ABF9c35f34ca1EDA8F0BeE4331Ef050',
  hemi: '0x07a66eBd9B0D8F438F889ecbcfd8D4681C21Fbc6',
  hyperevm: '0x7934e65283455BF25e6E9a6E3C48350D66944812',
  immutablezkevmmainnet: '0xEC23b0e4fb816B921940c4F11f70de63D0FcCa49',
  ink: '0x92EdF061E46Dcf15941CA4D5F2d168f643079343',
  katana: '0x956993Aee1CFFA32942b5ddC6Db2E8620b85cfbC',
  linea: '0x7b3d694BdeAE8F496Cc5eD0736c5f734cd231079',
  lisk: '0x7cB0e36Ec34C7c97A270bcBF64d4c967A22f1371',
  lukso: '0x4FE49931D3577c64B94cD1f1040A9781D41ACf95',
  lumiaprism: '0x1eeF460F51e86Da8D0a9c16f827237f682fBC532',
  mantle: '0x352A39EeeFCaaf13b157F869AD8ed69e7cf0a340',
  matchain: '0xCDA995D800F9Bc32814eC95277DF5BF0F9F243F9',
  metal: '0x0F6c9f5753f03748fB61A8C7b038f1D7C2240C10',
  metis: '0xd37fD87a28A5702643a0f937de248E7673594528',
  mode: '0x7Ef84bbc24118619655031f6404d6C81BC1AB534',
  monad: '0x40DdDF59209dAA5aE927207ab697e66D51581D87',
  morph: '0x8fe7d190e657D20e1958AB1497AbC7F1Ab4503F5',
  nibiru: '0x985D77eeC388e7A8b827d8f3f7EF853b3d70320f',
  oortmainnet: '0xE92Bf41B0fd76f72274fECa87179AE6E235c3c7F',
  peaq: '0xbeCd9B31ba4DbAC6DDc5C42cCC5fAF408CAd4921',
  plume: '0x2a8320c609dcdcdC4Ad906d7e5D6426f7e1dA0e4',
  polygon: '0x8708C96f9879805c2E54818865cbFF27fb64000D',
  prom: '0x0A335686C1AdAD375feF9267dA235496E190991f',
  reactive: '0x9B56aBc4Fd0b01E143f5856607d261C5D871718F',
  ronin: '0x76554F623DaF13EEE8132F15983060555bf4668f',
  sei: '0xd30AF4e3786995Aa89Ef58ec5f3280b73386a944',
  soneium: '0x1472ab941e43D5D9Eadf33661D884F1A1ce0Ecb7',
  sonic: '0x888da4CDD0Af7c9BE436e31CE2Bb84b70447a22a',
  subtensor: '0xaABBDE4930e7D0a3F4E1e5296BB34F71533854AA',
  superseed: '0xb1Cb9F64B7C1cA6f58a1AF5DdA1B4c9982bAcE59',
  tac: '0x04a1F95339610733a6FdB4645A4b2e0B84770CB6',
  taiko: '0x1Ce682C48acBA8A5a5370dd05a09637Ea2977676',
  unichain: '0x20c2B4B4C7409D08AD70D5F9e317E98cfA9F49f7',
  vana: '0xcdB472A1411360151308be799cc36db7f982533E',
  worldchain: '0xF618140B147beeD17cB83d4Bb8343484D5295cd2',
  xlayer: '0xda9dbF5a41eAFE58D76120Adc2442F2c02AA76dF',

  // Aug 18, 2025 - Mitosis
  // ----------------------------------------------------------
  mitosis: '0x8C94C6c26c752fAa33bACD377b9198FE7fae0bF5',

  // Sept 22, 2025
  // ----------------------------------------------------------
  zerogravity: '0x8d8703Ea7E7A129a581DCA59B916Cc4410a61D47',

  // Jan 29, 2026 - Migrating Ontology to v2 ICAs
  // ----------------------------------------------------------

  // Mar 16, 2026
  // ----------------------------------------------------------
  igra: '0xfA14458b1907BDa6E48bA619aF715c4532c3486c',
  tron: '0xB960616C7E2ee0F2a296A4b2B9D0b3308E23A69D',

  // Mar 24, 2026
  // ----------------------------------------------------------
  plasma: '0x5f132a9a16F8e4AE1E2ec2F2bcEdf074d1496c3f',

  // Apr 2, 2026
  // ----------------------------------------------------------
  // mocachain: '0x978d92B88ddcE02879ADa3848F0bCD6279E93B73',
  // fluent: '0x978d92B88ddcE02879ADa3848F0bCD6279E93B73',
  // kiichain: '0x978d92B88ddcE02879ADa3848F0bCD6279E93B73',

  // May 11, 2026 - Moonpay CROSS/USDC route
  // ----------------------------------------------------------
  citrea: '0x682bc0Aca87491ECB3683911996F1d573F989141',

  // May 25, 2026
  // ----------------------------------------------------------
  nesa: '0x1A41fdB5908A7bb48d923cc184402ef750c57C0b',

  // Jun 18, 2026
  // ----------------------------------------------------------
  nexus: '0x488d1a010318941bF420FfcDc7aa8312b943C21E',
  robinhood: '0xaE3B79d7c9FBE5905fc5638Bb070dd356513d6fc',
  tea: '0xD7CfFFE7B51B2113B959A8EbA6c40F338eD8A4d5',
} as const;
