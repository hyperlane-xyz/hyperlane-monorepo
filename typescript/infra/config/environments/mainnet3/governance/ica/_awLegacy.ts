// Found by running:
import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// pnpm tsx ./scripts/keys/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --destinationChains <chain1> <chain2> ...
export const awIcasLegacy: ChainMap<Address> = {
  // Jul 14, 2026 - migrated to v2 ICA, see governance/ica/aw.ts
  // viction: '0x23ed65DE22ac29Ec1C16E75EddB0cE3A187357b4',

  // Jul 26, 2024 batch
  // ----------------------------------------------------------
  xlayer: '0x1571c482fe9E76bbf50829912b1c746792966369',
  worldchain: '0x1996DbFcFB433737fE404F58D2c32A7f5f334210',
  // zircuit: '0x0d67c56E818a02ABa58cd2394b95EF26db999aA3', // already has a safe

  // Aug 5, 2024 batch
  // ----------------------------------------------------------
  cyber: '0x984Fe5a45Ac4aaeC4E4655b50f776aB79c9Be19F',
  lisk: '0x22d952d3b9F493442731a3c7660aCaD98e55C00A',
  lukso: '0xc1e20A0D78E79B94D71d4bDBC8FD0Af7c856Dd7A',
  metis: '0xb51e63CD0842D670a13c88B159fCFc268DA652A3',
  xai: '0x22d952d3b9F493442731a3c7660aCaD98e55C00A',
  // taiko: '0x483D218D2FEe7FC7204ba15F00C7901acbF9697D', // renzo chain

  // Aug 26, 2024 batch
  // ----------------------------------------------------------
  astar: '0x6b241544eBa7d89B51b72DF85a0342dAa37371Ca',
  bitlayer: '0xe6239316cA60814229E801fF0B9DD71C9CA29008',
  coredao: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  flare: '0x689b8DaBBF2f9Fd83D37427A062B30edF463e20b',
  molten: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  shibarium: '0x6348FAe3a8374dbAAaE84EEe5458AE4063Fe2be7',

  // Sep 9, 2024 batch
  // ----------------------------------------------------------
  oortmainnet: '0x7021D11F9fAe455AB2f45D72dbc2C64d116Cb657',

  // Sep 19, 2024 SAFE --> ICA v1 Migration
  // ----------------------------------------------------------
  celo: '0x3fA264c58E1365f1d5963B831b864EcdD2ddD19b',
  avalanche: '0x8c8695cD9905e22d84E466804ABE55408A87e595',
  polygon: '0xBDD25dd5203fedE33FD631e30fEF9b9eF2598ECE',
  gnosis: '0xD42125a4889A7A36F32d7D12bFa0ae52B0AD106b',
  ancient8: '0xA9FD5BeB556AB1859D7625B381110a257f56F98C',
  mantle: '0x08C880b88335CA3e85Ebb4E461245a7e899863c9',
  bob: '0xc99e58b9A4E330e2E4d09e2c94CD3c553904F588',
  zetachain: '0xc876B8e63c3ff5b636d9492715BE375644CaD345',
  fusemainnet: '0xbBdb1682B2922C282b56DD716C29db5EFbdb5632',
  endurance: '0x470E04D8a3b7938b385093B93CeBd8Db7A1E557C',
  // sei: '0xabad187003EdeDd6C720Fc633f929EA632996567', // renzo chain

  // Oct 30, 2024 batch
  // ----------------------------------------------------------
  apechain: '0xe68b0aB6BB8c11D855556A5d3539524f6DB3bdc6',
  gravity: '0x3104ADE26e21AEbdB325321433541DfE8B5dCF23',
  kaia: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  morph: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  orderly: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',

  // Nov 8, 2024 batch
  // ----------------------------------------------------------
  chilizmainnet: '0x54AF0FCDCD58428f8dF3f825267DfB58f2C710eb',
  flowmainnet: '0x65528D447C93CC1A1A7186CB4449d9fE0d5C1928',
  immutablezkevmmainnet: '0x54AF0FCDCD58428f8dF3f825267DfB58f2C710eb',
  metal: '0xf1d25462e1f82BbF25b3ef7A4C94F738a30a968B',
  rarichain: '0xD0A4Ad2Ca0251BBc6541f8c2a594F1A82b67F114',
  prom: '0x1cDd3C143387cD1FaE23e2B66bc3F409D073aC3D',

  // Nov 21, 2024 batch
  // ----------------------------------------------------------
  boba: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  unichain: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  vana: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  bsquared: '0xd9564EaaA68A327933f758A54450D3A0531E60BB',
  superseed: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',

  // Dec 4, 2024 batch
  // ----------------------------------------------------------
  lumiaprism: '0xAFfA863646D1bC74ecEC0dB1070f069Af065EBf5',
  appchain: '0x4F25DFFd10A6D61C365E1a605d07B2ab0E82A7E6',

  // Dec 13, 2024 batch
  // ----------------------------------------------------------
  // corn: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  ink: '0xDde4Ce691d1c0579d48BCdd3491aA71472b6cC38',
  soneium: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  sonic: '0x5926599B8Aff45f1708b804B30213babdAD78C83',

  // Jan 13, 2025 batch
  // ----------------------------------------------------------
  artela: '0x745CEA119757ea3e27093da590bC91f408bD4448',
  hemi: '0x8D18CBB212920e5ef070b23b813d82F8981cC276',

  // Feb 3, 2025 batch
  // ----------------------------------------------------------
  // glue: '0x24832680dF0468967F413be1C83acfE24154F88D',
  matchain: '0x66af72e46b3e8DFc19992A2A88C05d9EEFE01ffB',

  // Q5, 2024 batch
  // ----------------------------------------------------------
  // berachain: '0x56895bFa7f7dFA5743b2A0994B5B0f88b88350F9',

  // Feb 17, 2025 batch
  // ----------------------------------------------------------
  arcadia: '0xD2344a364b6Dc6B2Fe0f7D836fa344d83056cbaD',
  ronin: '0x8768A14AA6eD2A62C77155501E742376cbE97981',
  subtensor: '0x61BFbb5FEC57f5470388A80946F0415138630b9c',

  // Mar 14, 2025 batch
  // ----------------------------------------------------------
  plume: '0x61BFbb5FEC57f5470388A80946F0415138630b9c',

  // Mar 31, 2025 batch
  // ----------------------------------------------------------
  coti: '0x294589E4913A132A49F7830a2A219363A25c0529',
  // nibiru: '0x40cD75e80d04663FAe0CE30687504074F163C346', // temporary while looking into decimals
  opbnb: '0xeFb7D10Da69A0a913485851ccec6B85cF98d9cab',
  reactive: '0x9312B04076efA12D69b95bcE7F4F0EA847073E6a',

  // Jun 5, 2025 - oUSDT v2
  // ----------------------------------------------------------
  hashkey: '0xEE01c007f89c9255f43b91B591b93cD1459048D1',

  // Jun 21, 2025 - oUSDT v3
  // ----------------------------------------------------------
  swell: '0xff8326468e7AaB51c53D3569cf7C45Dd54c11687',
  botanix: '0xf06c254d1Df285BC16B2D53A426dC106897CfDf9',

  // Jun 30, 2025 - cctp upgrade
  // ----------------------------------------------------------
  // arbitrum: '0xaB547e6cde21a5cC3247b8F80e6CeC3a030FAD4A',
  // optimism: '0x20E9C1776A9408923546b64D5ea8BfdF0B7319d6',
  // base: '0xA6D9Aa3878423C266480B5a7cEe74917220a1ad2',
} as const;
