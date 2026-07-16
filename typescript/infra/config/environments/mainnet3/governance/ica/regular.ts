// Found by running:
import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// REGISTRY_URI=/Users/pbio/work/tmpauditq2/hyperlane-registry \
// pnpm tsx scripts/keys/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --deploy \
// --governanceType regular
// -c <chain1> <chain2> ... \
export const regularIcas: ChainMap<Address> = {
  // owner chain
  // ethereum: '0x28699e5d9feb54131FB14D7446d2771623295781',

  // keep safe-owned for now
  // arbitrum: '0xCC7F1D17351AD37E58758A329E553FB9566562E6',
  // base: '0xE3020af3784788cA04E4E68d3A9A827f2B14Bf3b',
  // bsc: '0x2be13bE357bd9Bca5aAA4Fb4917A8bc4EFDF661c',
  // optimism: '0x62FAaf58331B379569D435F08633361f0Be50cB8',

  // Jul 2, 2025 - ICA 2.0 Migration
  // ----------------------------------------------------------
  apechain: '0x0880453D948E4D2a06F40c6Cf4eF33E4e938411f',
  appchain: '0x863226b1F78f40a3Ab63D89910B2CC5e899CC94D',
  botanix: '0xe30183bab232021BcA9f56588CE09fF9842AB29D',
  avalanche: '0x66C21CFa8b765318a458435519A31A5cf0F7Ae4b',
  berachain: '0xb6DD23C2Bef77e90DdDBeEdEa29a56880ED750f0',
  bitlayer: '0x033cF796F8f84279F9bA61206869c0E05E41BcFc',
  blast: '0x59C89E3f2481C8c062E7DeEFFF70B75fbBd0b89a',
  bob: '0x2282ef5C6654DF3796ccc3e6A1AE33c40801E89D',
  boba: '0x247510A4001b78decE23B2d773aa8C2c9f6939C3',
  celo: '0x39feCE4cA4b41bd2dfA886A6cB08353A42DbB6E3',
  coti: '0x41A362f117D4EbE2680F6d4E37ddC5454dc5f07a',
  flowmainnet: '0xf2A87fd04C42D51D53c2A35E957981bA59b46F9e',
  fraxtal: '0xc96634cdc475FfC7702f123EFD77cB43c861956b',
  galactica: '0x6C8210C82B17bE639CeDB3349A5aeDFF1471f72A',
  gnosis: '0xf38bb17117000b560ecdeaA5b736f3aFCc39C3b5',
  hashkey: '0xDfC5cAEC02737d0FD2868cCa379D866DF96ACe27',
  hemi: '0xAf6dC78dCA99812D3bB729e3C17C527F74CD261F',
  hyperevm: '0xD50d4E42F41392d5c7E9526423D3dc38a8d1f875',
  immutablezkevmmainnet: '0x71c47adC3270EA319705626b8769E0ee54D1EA41',
  ink: '0x20b3D70fA3d7B69Aba42b0bA9D8F25Ee0C656e78',
  katana: '0x53dE35b799fD29B129E683E43ef31cEEB3b88D22',
  linea: '0x999bD2da1f24aece8c558E54350FB06eF8ceFe5C',
  lisk: '0xe1D145f3c539f287789D6f8C6Bc010a1fECdb259',
  lukso: '0x5045dE416efC1738046E26Bf30dfEf9CB60C8de7',
  lumiaprism: '0x5C6Bc53c4e0d7DAAee0bb5F9181f476c77643576',
  mantle: '0x556C39820DBBB3Cd6f4c164CD91F755f89Ac8c62',
  matchain: '0x9F31268d17Eab404ED2DEdFbb8ba0022E3fF621f',
  metal: '0x1547282562E9b32561C7bdD41cAfB5ce89Ff08dA',
  metis: '0xD998C3Ee6b8EE592C7d0bcf8e5b43F4Dc314C07F',
  mode: '0x917445680fbd406747abFa78F381efd63F4aF599',
  morph: '0x1a4f0d915ce6FAe98B6b1c78FcbB8c122f30afCd',
  nibiru: '0xdb10a32F38A8c1B944277fA2Dd6Dfd89aD83480F',
  oortmainnet: '0x7038d9B38D417bB0b9f30158697e333B1dd921E3',
  // ontology: '0xA59Eb6F5C4C365f533407E978321531E9F610b02',
  peaq: '0xE21447D4f0F993dD8C1C86Cd216E2E68f2a1CdcE',
  plume: '0x2E625B8191C8b1CEceAB6B6d3c833547A337e7F2',
  polygon: '0x20e52e3BeDf7BD305Ca816Dc54a0835D3bDeD820',
  prom: '0x024b2F836A29F80859dE21C0Dc0410b538742560',
  reactive: '0xc192035485ac67334A8A2080f7C4930624DAAa9C',
  ronin: '0x8B15B5861d1F391F98e2014aB510aF2320CA6eBD',
  sei: '0x8a3A8A4C9f188bbD45E75271Dc590077fc96EDc7',
  soneium: '0x6af23EB68a6223a4af9F056E10D93ef4d960Da05',
  sonic: '0x39e4A8F7AA0826b1Bf94551A00eB2142AC7D5Bb5',
  subtensor: '0x4C8D6Ae76a04108E20d1Cc114041c632aC040ABC',
  superseed: '0xE9617FA7edD4741997Ee994038D977a377612Ae1',
  tac: '0xb801C2712f92E2d29e1120862e0f9C93d80CbBcA',
  taiko: '0x2ca9CC72285EE7D6c7344623F2Bfffcc8894005c',
  unichain: '0xD39c288D2A021207Dfec7780e778D73460f563D7',
  vana: '0x486815B6D0dC66B041965dB1904872167ddcE433',
  worldchain: '0x17f0207b9529cAb39F6e02394157b5a6c7064393',
  xlayer: '0xAD598d164ecFf737C7556871Bb1D50215c4D9517',

  // Aug 18, 2025 - Mitosis
  // ----------------------------------------------------------
  mitosis: '0x287Df0906671Fb56f6c2FDC0617F82D422796F8D',

  // Sept 3, 2025 - Pulsechain
  // ----------------------------------------------------------
  pulsechain: '0x72655e4683E802AeaF7bff4Dd0189293dc16cD62',

  // Sept 8, 2025
  // ----------------------------------------------------------
  plasma: '0xd7e64bA7BB6beE321D5E0C42a966FDc97f70a92f',
  electroneum: '0xd7e64bA7BB6beE321D5E0C42a966FDc97f70a92f',

  // Sept 22, 2025
  // ----------------------------------------------------------
  zerogravity: '0x53FEEdcF42C1aACFeC3FA6Da573a3470FcD5C658',
  mantra: '0x6b3353A453689a92aE3138c4d26e4eaD894b39D8',

  // Oct 2, 2025
  // ----------------------------------------------------------
  carrchain: '0x86563B7E9499Cd826bC5e6a1D98436aDb440DDb2',
  monad: '0x9126696d9C3c44dc1273352ce171E359b1802560',

  // Dec 4, 2025
  // ----------------------------------------------------------
  stable: '0x669385086e9Bb39aa29653eaACB0F169066c89C5',
  somnia: '0xe26f1A5681088b7dCd53c00C9a19143e8bA543Ec',
  lazai: '0xDFEa2EB38AA77EE41D50794aFaA34463EEabD4BB',
  megaeth: '0x8D628b83A2F915fab39f7F09e0cF7A3ea8F9bF42',
  adichain: '0xD0427bD81a0cDA1AdcdFb49DFDB95Ab3e059FFff',

  // Jan 2, 2026
  // ----------------------------------------------------------
  citrea: '0x4fC003a348D6b244B01170D08CF69373c11FBf01',

  // Jan 4, 2026
  // ----------------------------------------------------------
  eni: '0x2C5418067111F7e728D64C5D63bc87F3A7f8C6FC',
  krown: '0x9F48298FF8c32F423fe14e71e6CBAcBa3c061e17',

  // Jan 29, 2026 - Migrating Ontology to v2 ICAs
  // ----------------------------------------------------------

  // Mar 16, 2026
  // ----------------------------------------------------------
  igra: '0x2EA494A9Df761F8c9D619d7C130203AE31a01bC4',
  tron: '0x2839B41900b59dEBb43E7d70630BF92d10b86D21',

  // Apr 2, 2026
  // ----------------------------------------------------------
  mocachain: '0x50c0D2A50A9d4143c856D9323228F2C7fa63906f',
  fluent: '0x50c0D2A50A9d4143c856D9323228F2C7fa63906f',
  kiichain: '0x50c0D2A50A9d4143c856D9323228F2C7fa63906f',

  // May 25, 2026
  // ----------------------------------------------------------
  nesa: '0x661a4896f7f8B203E23e326500f754b9ED9571Eb',

  // Jun 18, 2026
  // ----------------------------------------------------------
  nexus: '0xCc00d7F9aa7124ee0D9Ad366dd8C632266075A53',
  robinhood: '0x0e7E5D38695d7939303244AD56ace1eeA263DcE8',
  tea: '0x561B8D19712dB57cd52bbD8dc3F3327Ce0A1aF49',
} as const;
