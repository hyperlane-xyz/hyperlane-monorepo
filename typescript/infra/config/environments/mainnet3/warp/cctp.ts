// from https://developers.circle.com/stablecoins/evm-smart-contracts

export const tokenMessengerAddresses = {
  ethereum: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
  avalanche: '0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982',
  optimism: '0x2B4069517957735bE00ceE0fadAE88a26365528f',
  arbitrum: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
  base: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
  polygon: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
  unichain: '0x4e744b28E787c3aD0e810eD65A24461D4ac5a762',
} as const;

export const messageTransmitterAddresses = {
  ethereum: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81',
  avalanche: '0x8186359aF5F57FbB40c6b14A588d2A59C0C29880',
  optimism: '0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8',
  arbitrum: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
  base: '0xAD09780d193884d503182aD4588450C416D6F9D4',
  polygon: '0xF3be9355363857F3e001be68856A2f96b4C39Ba9',
  unichain: '0x353bE9E2E38AB1D19104534e4edC21c643Df86f4',
} as const;

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
  linea: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  near: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  noble: 'uusdc',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  polkadotassethub: '1337',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  sonic: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
  stellar: 'USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  sui: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  tron: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
  unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  zksyncera: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
} as const;
