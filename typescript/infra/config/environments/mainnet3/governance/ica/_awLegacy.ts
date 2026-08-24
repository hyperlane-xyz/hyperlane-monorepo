// Found by running:
import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// pnpm tsx ./scripts/keys/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --destinationChains <chain1> <chain2> ...
export const awIcasLegacy: ChainMap<Address> = {
  viction: '0x23ed65DE22ac29Ec1C16E75EddB0cE3A187357b4',

  // Jul 26, 2024 batch
  // ----------------------------------------------------------
  xlayer: '0x1571c482fe9E76bbf50829912b1c746792966369',
  worldchain: '0x1996DbFcFB433737fE404F58D2c32A7f5f334210',

  // Aug 5, 2024 batch
  // ----------------------------------------------------------
  lisk: '0x22d952d3b9F493442731a3c7660aCaD98e55C00A',
  lukso: '0xc1e20A0D78E79B94D71d4bDBC8FD0Af7c856Dd7A',
  metis: '0xb51e63CD0842D670a13c88B159fCFc268DA652A3',
  // taiko: '0x483D218D2FEe7FC7204ba15F00C7901acbF9697D', // renzo chain

  // Aug 26, 2024 batch
  // ----------------------------------------------------------

  // Sep 9, 2024 batch
  // ----------------------------------------------------------

  // Sep 19, 2024 SAFE --> ICA v1 Migration
  // ----------------------------------------------------------
  celo: '0x3fA264c58E1365f1d5963B831b864EcdD2ddD19b',
  avalanche: '0x8c8695cD9905e22d84E466804ABE55408A87e595',
  polygon: '0xBDD25dd5203fedE33FD631e30fEF9b9eF2598ECE',
  gnosis: '0xD42125a4889A7A36F32d7D12bFa0ae52B0AD106b',
  mantle: '0x08C880b88335CA3e85Ebb4E461245a7e899863c9',
  bob: '0xc99e58b9A4E330e2E4d09e2c94CD3c553904F588',
  // sei: '0xabad187003EdeDd6C720Fc633f929EA632996567', // renzo chain

  // Oct 30, 2024 batch
  // ----------------------------------------------------------
  apechain: '0xe68b0aB6BB8c11D855556A5d3539524f6DB3bdc6',

  // Nov 8, 2024 batch
  // ----------------------------------------------------------
  flowmainnet: '0x65528D447C93CC1A1A7186CB4449d9fE0d5C1928',
  immutablezkevmmainnet: '0x54AF0FCDCD58428f8dF3f825267DfB58f2C710eb',
  metal: '0xf1d25462e1f82BbF25b3ef7A4C94F738a30a968B',

  // Nov 21, 2024 batch
  // ----------------------------------------------------------
  unichain: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  superseed: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',

  // Dec 4, 2024 batch
  // ----------------------------------------------------------
  appchain: '0x4F25DFFd10A6D61C365E1a605d07B2ab0E82A7E6',

  // Dec 13, 2024 batch
  // ----------------------------------------------------------
  // corn: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  ink: '0xDde4Ce691d1c0579d48BCdd3491aA71472b6cC38',
  soneium: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  sonic: '0x5926599B8Aff45f1708b804B30213babdAD78C83',

  // Jan 13, 2025 batch
  // ----------------------------------------------------------

  // Feb 3, 2025 batch
  // ----------------------------------------------------------
  // glue: '0x24832680dF0468967F413be1C83acfE24154F88D',

  // Q5, 2024 batch
  // ----------------------------------------------------------
  // berachain: '0x56895bFa7f7dFA5743b2A0994B5B0f88b88350F9',

  // Feb 17, 2025 batch
  // ----------------------------------------------------------
  subtensor: '0x61BFbb5FEC57f5470388A80946F0415138630b9c',

  // Mar 14, 2025 batch
  // ----------------------------------------------------------

  // Mar 31, 2025 batch
  // ----------------------------------------------------------
  coti: '0x294589E4913A132A49F7830a2A219363A25c0529',

  // Jun 5, 2025 - oUSDT v2
  // ----------------------------------------------------------

  // Jun 21, 2025 - oUSDT v3
  // ----------------------------------------------------------

  // Jun 30, 2025 - cctp upgrade
  // ----------------------------------------------------------
  // arbitrum: '0xaB547e6cde21a5cC3247b8F80e6CeC3a030FAD4A',
  // optimism: '0x20E9C1776A9408923546b64D5ea8BfdF0B7319d6',
  // base: '0xA6D9Aa3878423C266480B5a7cEe74917220a1ad2',
} as const;
