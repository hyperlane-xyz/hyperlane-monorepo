import { AbacusDomain } from './domain';

export const alfajores: AbacusDomain = {
  name: 'alfajores',
  id: 1000,
  bridgeRouter: '0xd6930Ee55C141E5Bb4079d5963cF64320956bb3E',
  outbox: '0xc8abA9c65A292C84EA00441B81124d9507fB22A8',
  governanceRouter: '0x760AbbE9496BD9cEe159402E2B4d96E3d76dbE6a',
  xAppConnectionManager: '0x02c144AeBA550634c8EE185F78657fd3C4a3F9B5',
  inboxs: [
    { domain: 2000, address: '0x7149bF9f804F27e7259d0Ce328Dd5f6D5639ef19' },
    { domain: 3000, address: '0xE469D8587D45BF85297BD924b159E726E7CA5408' },
  ],
};

export const kovan: AbacusDomain = {
  name: 'kovan',
  id: 3000,
  bridgeRouter: '0x359089D34687bDbFD019fCC5093fFC21bE9905f5',
  ethHelper: '0x411ABcFD947212a0D64b97C9882556367b61704a',
  outbox: '0xB6Ee3e8fE5b577Bd6aB9a06FA169F97303586E7C',
  governanceRouter: '0xa95868Ffaed7489e9059d4a08A0C1B0F78041b33',
  xAppConnectionManager: '0x1d9Af80594930574201d919Af0fBfe6bb89800E2',
  inboxs: [
    { domain: 1000, address: '0xF76995174f3C02e2900d0F6261e8cbeC04078E1f' },
    { domain: 2000, address: '0xFF47138c42119Fe0B1f267e2fa254321DE287Fc6' },
  ],
};

export const rinkeby: AbacusDomain = {
  name: 'rinkeby',
  id: 2000,
  bridgeRouter: '0x8FbEA25D0bFDbff68F2B920df180e9498E9c856A',
  ethHelper: '0x1BEBC8F1260d16EE5d1CFEE9366bB474bD13DC5f',
  outbox: '0x8459EDe1ed4dADD6D5B142d845240088A6530Cf8',
  governanceRouter: '0x8f8424DC94b4c302984Ab5a03fc4c2d1Ec95DC92',
  xAppConnectionManager: '0x53B94f2D4a3159b66fcCC4f406Ea388426A3f3cB',
  inboxs: [
    { domain: 1000, address: '0xb473F5e0AAf47Ba54dac048633e7b578c1eBde01' },
    { domain: 3000, address: '0x7EB8450a5397b795F2d89BC48EA20c24fa147F11' },
  ],
};

export const testnetLegacyDomains = [alfajores, kovan, rinkeby];
