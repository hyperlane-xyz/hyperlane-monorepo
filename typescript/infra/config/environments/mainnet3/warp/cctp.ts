// from https://developers.circle.com/stablecoins/evm-smart-contracts

export const tokenMessengerV1Addresses = {
  ethereum: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
  avalanche: '0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982',
  optimism: '0x2B4069517957735bE00ceE0fadAE88a26365528f',
  arbitrum: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
  base: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
  polygon: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
  unichain: '0x4e744b28E787c3aD0e810eD65A24461D4ac5a762',
} as const;

export const messageTransmitterV1Addresses = {
  ethereum: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81',
  avalanche: '0x8186359aF5F57FbB40c6b14A588d2A59C0C29880',
  optimism: '0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8',
  arbitrum: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
  base: '0xAD09780d193884d503182aD4588450C416D6F9D4',
  polygon: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
  unichain: '0x353bE9E2E38AB1D19104534e4edC21c643Df86f4',
} as const;

export const tokenMessengerV2Addresses = {
  ethereum: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  avalanche: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  optimism: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  arbitrum: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  base: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  polygon: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  unichain: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  linea: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  sonic: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  worldchain: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  sei: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  hyperevm: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  ink: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  plume: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
} as const;

export const messageTransmitterV2Addresses = {
  ethereum: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  avalanche: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  optimism: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  arbitrum: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  base: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  polygon: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  unichain: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  linea: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  sonic: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  worldchain: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  sei: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  hyperevm: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  ink: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  plume: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
} as const;

// https://developers.circle.com/cctp/technical-guide#cctp-v2-fees
// Note: Contract uses integer bps precision. Values are rounded up from Circle's
// actual fees (e.g., 1.3 bps -> 2 bps) since fractional bps aren't supported.
export const FAST_TRANSFER_FEE_BPS: Partial<
  Record<keyof typeof tokenMessengerV2Addresses, number>
> = {
  arbitrum: 2,
  base: 2,
  ethereum: 1,
  ink: 2,
  linea: 11,
  optimism: 2,
  plume: 2,
  unichain: 2,
  worldchain: 1,
};

// https://developers.circle.com/cctp/technical-guide#cctp-v2-finality-thresholds
export const FAST_FINALITY_THRESHOLD = 1000;
export const STANDARD_FINALITY_THRESHOLD = 2000;

export const usdcTokenAddresses = {
  algorand: '31566704',
  aptos: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  celo: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  flow: 'A.b19436aae4d94622.FiatToken',
  hedera: '0.0.456858',
  hyperevm: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  ink: '0x2D270e6886d130D724215A266106e6832161EAEd',
  linea: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  near: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  monad: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  noble: 'uusdc',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  polkadotassethub: '1337',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  plume: '0x222365EF19F7947e5484218551B56bb3965Aa7aF',
  sei: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
  sonic: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
  stellar: 'USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  sui: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  tron: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
  unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  worldchain: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1',
  zksync: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
  solanamainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  starknet:
    '0x053C91253BC9682c04929cA02ED00b3E423f6710D2ee7e0D5EBB06F3eCF368A8',
  paradex: '0x7348407ebad690fec0cc8597e87dc16ef7b269a655ff72587dafff83d462be2',
} as const;

export type UsdcChainId = keyof typeof usdcTokenAddresses;
