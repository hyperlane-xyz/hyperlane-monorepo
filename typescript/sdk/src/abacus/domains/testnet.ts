import { AbacusDomain } from './domain';

export const alfajores: AbacusDomain = {
  name: 'alfajores',
  id: 1000,
  bridgeRouter: '0xe29Abbc3669064d8aF9F6BE378179a133664a92C',
  outbox: '0xDf89d5d4039ada018BCDb992Bb6C2e05fEf86328',
  governanceRouter: '0x1E2DE9CD3f64c4e9AadE11a60C7b3620dD026888',
  xAppConnectionManager: '0x56Bf96be9ab395aa2861E7Ae4aCEFc11D8C2Ec49',
  inboxes: [
    { domain: 3, address: '0xC9e581Cd4fF6533f5ccBA4Dc5d5f642B8b658B93' },
    { domain: 5, address: '0x4eAD31e37b950B32b9EBbE747f0ef4BffAc336a5' },
    { domain: 3000, address: '0x15fA9169F7495162ac52b4A7957c9054097Ab0FF' },
  ],
};

export const ropsten: AbacusDomain = {
  name: 'ropsten',
  id: 3,
  bridgeRouter: '0xe29Abbc3669064d8aF9F6BE378179a133664a92C',
  ethHelper: '0x9A0e88a3D8CF09F3dc5Ba65640299DE3D87f926C',
  outbox: '0x7E26E170dB94E81979927d2D39CB703048Ad599D',
  governanceRouter: '0xa8C889D257d9eE02cb957941cd785CfffDe5a453',
  xAppConnectionManager: '0xe5C92bC2a443016c00b3908dFA63f55bEe1a7a16',
  inboxes: [
    { domain: 5, address: '0x15C1edbf6E6161d50d58682dF7587F0d61db5C38' },
    { domain: 1000, address: '0x30dAE25E9eBd644841d1A1fF25e303331B1CdEb3' },
    { domain: 3000, address: '0xF782C67AA111a9D75f6ccEf3d7aDB54620D5A8e9' },
  ],
};

export const kovan: AbacusDomain = {
  name: 'kovan',
  id: 3000,
  bridgeRouter: '0x9A0e88a3D8CF09F3dc5Ba65640299DE3D87f926C',
  ethHelper: '0x8c7510966c0312dEb2305A5E1C923CE48bbf55Ce',
  outbox: '0x7E26E170dB94E81979927d2D39CB703048Ad599D',
  governanceRouter: '0xa8C889D257d9eE02cb957941cd785CfffDe5a453',
  xAppConnectionManager: '0xe5C92bC2a443016c00b3908dFA63f55bEe1a7a16',
  inboxes: [
    { domain: 3, address: '0x15C1edbf6E6161d50d58682dF7587F0d61db5C38' },
    { domain: 5, address: '0xF782C67AA111a9D75f6ccEf3d7aDB54620D5A8e9' },
    { domain: 1000, address: '0x30dAE25E9eBd644841d1A1fF25e303331B1CdEb3' },
  ],
};

export const gorli: AbacusDomain = {
  name: 'gorli',
  id: 5,
  bridgeRouter: '0xe29Abbc3669064d8aF9F6BE378179a133664a92C',
  ethHelper: '0x9A0e88a3D8CF09F3dc5Ba65640299DE3D87f926C',
  outbox: '0xDf89d5d4039ada018BCDb992Bb6C2e05fEf86328',
  governanceRouter: '0x1E2DE9CD3f64c4e9AadE11a60C7b3620dD026888',
  xAppConnectionManager: '0x56Bf96be9ab395aa2861E7Ae4aCEFc11D8C2Ec49',
  inboxes: [
    { domain: 3, address: '0xC9e581Cd4fF6533f5ccBA4Dc5d5f642B8b658B93' },
    { domain: 1000, address: '0x15fA9169F7495162ac52b4A7957c9054097Ab0FF' },
    { domain: 3000, address: '0x4eAD31e37b950B32b9EBbE747f0ef4BffAc336a5' },
  ],
};

export const testnetDomains = [alfajores, ropsten, kovan, gorli];
