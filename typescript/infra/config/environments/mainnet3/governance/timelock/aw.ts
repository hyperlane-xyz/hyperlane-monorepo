import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export const awTimelocks: ChainMap<Address> = {
  // Jul 18, 2025 - Timelock for "Abacus Works" Safe
  // ----------------------------------------------------------
  ethereum: '0x469f45d05F8C3B3cE40d1640ffE66b795B1d2d22',

  // Jul 18, 2025 - Timelocks for v2 "Abacus Works" ICAs
  // ----------------------------------------------------------
  apechain: '0x1A4E4661b0027b859bF5c671d599f02dE68f0345',
  appchain: '0xf2F83b26d56f0e9B9Bd81efAb9e0ECB9ba5708be',
  arbitrum: '0x8abE651230Ce65f546eb78C9Ed7fe54e15650224',
  avalanche: '0xFd3617B8c53c59F9642C8a5ec0ae5CD4E72bC72E',
  base: '0xe38714D00cAa906065D872D177C1374C847035fF',
  berachain: '0x549a5f60F7751191894437A24E0945924FF1965F',
  blast: '0x979Ca5202784112f4738403dBec5D0F3B9daabB9',
  bob: '0x790306c30eFeeAF3943ee3700C71D7B7812c85a1',
  bsc: '0x09F4D4e765A911B867263d4Ff5e73323281De80D',
  celo: '0xb527ea7ff1B14fEb9FFF98b5Cd750Bd311cD598F',
  coti: '0x4Fea96D613F51fF83459d101e256Cd165a1e73BB',
  flowmainnet: '0x3D6597Ae622D6223d60a57E92c2F259283dD2D69',
  fraxtal: '0x09F478e8dEB9Ef466025bf96d13cd9DC56881E18',
  galactica: '0xF100a80D9e47518a14C68Fca0a113E849be27411',
  gnosis: '0x04587eF285B3028E281f21Ad94C7a16bE138381D',
  hyperevm: '0x677fbdE16AC399Bcd1d136b822939ea1b50D31E2',
  immutablezkevmmainnet: '0x3de63b62BeF9Da290F51f856cA9F3dB4225EDc05',
  ink: '0xED56728fb977b0bBdacf65bCdD5e17Bb7e84504f',
  katana: '0x9C6e8d989ea7F212e679191BEb44139d83ac927a',
  linea: '0x3A2e96403d076e9f953166A9E4c61bcD9D164CFe',
  lisk: '0xfA96BCb61C7CbD7839689E807CD6d7FC27754Af3',
  lukso: '0x23D26a5Fe6671B0c13E0970c15f595CF1e9a7785',
  mantle: '0xA3C59Caa046Ac6234272c74ADaE5f202E57F6e33',
  metal: '0xA312a8329bCDc2e5EA5dc2849326a45D40C58e8F',
  metis: '0xfc8b34Fa72310A2926A0668e05F17F21c9811b80',
  mode: '0x5CC74C639310B6865d2Ef2E92ed4B68fcd96Ff88',
  optimism: '0x1C9192aB4aDc226FF20121624590650b076492BE',
  polygon: '0x90900629ea141bfBcE7f70De1Cb78B74199A93E6',
  sei: '0xd223107e1B9fd4a298b52a49564626D10d6E5c44',
  soneium: '0x39d3c2Cf646447ee302178EDBe5a15E13B6F33aC',
  sonic: '0x591273A518b59B4E9E4c104B001Fee4B9920244F',
  subtensor: '0x678230D21ab989A2D65363373Dd45B6a08c2A3EC',
  superseed: '0xEd9c6B30482ACe8De6366a1858D0702111852449',
  swell: '0xc82C44E3b5fA9fa9915F4c09fB0b5bb9e417625c',
  tac: '0x9c64f327F0140DeBd430aab3E2F1d6cbcA921227',
  taiko: '0x61683848c92927376DE30F3B52558655c13269d1',
  unichain: '0x6291596339A6EDD6cD68aca1d1c08B1fa2115F8C',
  worldchain: '0x1008FAbD07aBd93a7D9bB81803a89cC3a834E1A9',
  xlayer: '0x575a4b7D13978421Bb7cEbf470A8e5E40f911a29',

  // Sep 22, 2025 - Timelock for 0G oUSDT extension
  // ----------------------------------------------------------
  zerogravity: '0x11EF91d17c5ad3330DbCa709a8841743d3Af6819',
} as const;
