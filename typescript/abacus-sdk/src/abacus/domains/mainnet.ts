import { AbacusDomain } from './domain';

export const celo: AbacusDomain = {
  name: 'celo',
  id: 1667591279,
  bridgeRouter: '0x1548cf5cf7dBd93f4dA11f45fCce315573d21B60',
  home: '0x913EE05036f3cbc94Ee4afDea87ceb430524648a',
  governanceRouter: '0xd13aC1024d266B73180cA7445Ca0E78b3Acfe8CE',
  xAppConnectionManager: '0xaa099aF87ACE9E437b9B410a687F263eeaeC4321',
  replicas: [
    { domain: 6648936, address: '0xcDE146d1C673fE13f4fF1569d3F0d9f4d0b9c837' },
    {
      domain: 1635148152,
      address: '0x2784a755690453035f32Ac5e28c52524d127AfE2',
    },
    {
      domain: 1886350457,
      address: '0xfde0a96468ae91B4E13794E1B8e5B222E7Db6a23',
    },
  ],
};

export const ethereum: AbacusDomain = {
  name: 'ethereum',
  id: 6648936,
  bridgeRouter: '0x4fc16De11deAc71E8b2Db539d82d93BE4b486892',
  ethHelper: '0x2784a755690453035f32Ac5e28c52524d127AfE2',
  home: '0xa73a3a74C7044B5411bD61E1990618A1400DA379',
  governanceRouter: '0xcbcF180dbd02460dCFCdD282A0985DdC049a4c94',
  xAppConnectionManager: '0x8A926cE79f83A5A4C234BeE93feAFCC85b1E40cD',
  replicas: [
    {
      domain: 1635148152,
      address: '0xaa099aF87ACE9E437b9B410a687F263eeaeC4321',
    },
    {
      domain: 1667591279,
      address: '0x27658c5556A9a57f96E69Bbf6d3B8016f001a785',
    },
    {
      domain: 1886350457,
      address: '0x4eA75c12eD058F0e6651475688a941555FA62395',
    },
  ],
};

export const avalanche: AbacusDomain = {
  name: 'avalanche',
  id: 1635148152,
  paginate: {
    blocks: 1000000,
    from: 6765067,
  },
  bridgeRouter: '0xB6bB41B1fb8c381b002C405B8abB5D1De0C0abFE',
  ethHelper: '0x4fc16De11deAc71E8b2Db539d82d93BE4b486892',
  home: '0x101a39eA1143cb252fc8093847399046fc35Db89',
  governanceRouter: '0x4d89F34dB307015F8002F97c1d100d84e3AFb76c',
  xAppConnectionManager: '0x81B97dfBB743c343983e9bE7B863dB636DbD7373',
  replicas: [
    { domain: 6648936, address: '0xCf9066ee2fF063dD09862B745414c8dEa4Cc0497' },
    {
      domain: 1667591279,
      address: '0xA734EDE8229970776e1B68085D579b6b6E97dAd4',
    },
    {
      domain: 1886350457,
      address: '0x706DC810c79dAAFb82D304D7C9ff9518D8B43Fae',
    },
  ],
};

export const polygon: AbacusDomain = {
  name: 'polygon',
  id: 1886350457,
  paginate: {
    // This needs to be stupidly low to avoid RPC timeouts
    blocks: 10000,
    from: 19657100,
  },
  bridgeRouter: '0x3a5846882C0d5F8B0FA4bB04dc90C013104d125d',
  ethHelper: '0xa489b8981ae5652C9Dd6515848cB8Dbecae5E1B0',
  home: '0xCf9066ee2fF063dD09862B745414c8dEa4Cc0497',
  governanceRouter: '0xf1dd0edC8f8C9a881F350e8010e06bE9eaf7DafA',
  xAppConnectionManager: '0x4eA75c12eD058F0e6651475688a941555FA62395',
  replicas: [
    { domain: 6648936, address: '0x2784a755690453035f32Ac5e28c52524d127AfE2' },
    {
      domain: 1635148152,
      address: '0xfde0a96468ae91B4E13794E1B8e5B222E7Db6a23',
    },
    {
      domain: 1667591279,
      address: '0x45D35F60Ccf8F7031FB5A09954Cd923A9E84F89d',
    },
  ],
};

export const mainnetDomains = [celo, ethereum, avalanche, polygon];
