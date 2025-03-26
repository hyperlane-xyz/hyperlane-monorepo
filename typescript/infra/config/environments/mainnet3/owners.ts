import { AddressesMap, ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { getMainnetAddresses } from '../../registry.js';

import { ethereumChainNames } from './chains.js';
import { supportedChainNames } from './supportedChainNames.js';

export const upgradeTimelocks: ChainMap<Address | undefined> = {
  arbitrum: '0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01',
  ethereum: '0x59cf937Ea9FA9D7398223E3aA33d92F7f5f986A2', // symbiotic network timelock
};

export const timelocks: ChainMap<Address> = {
  ...upgradeTimelocks,
  ethereum: '0x59cf937Ea9FA9D7398223E3aA33d92F7f5f986A2', // symbiotic network timelock
};

export function localAccountRouters(): ChainMap<Address> {
  const coreAddresses: ChainMap<AddressesMap> = getMainnetAddresses();
  const filteredAddresses = objFilter(
    coreAddresses,
    (_, addressMap): addressMap is AddressesMap =>
      addressMap.interchainAccountRouter !== undefined,
  );
  return objMap(
    filteredAddresses,
    (_, addressMap) => addressMap.interchainAccountRouter,
  );
}

export const safes: ChainMap<Address> = {
  mantapacific: '0x03ed2D65f2742193CeD99D48EbF1F1D6F12345B6', // does not have a UI
  celo: '0x879038d6Fc9F6D5e2BA73188bd078486d77e1156',
  ethereum: '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6',
  avalanche: '0x5bE94B17112B8F18eA9Ac8e559377B467556a3c3',
  polygon: '0xf9cFD440CfBCfAB8473cc156485B7eE753b2913E',
  bsc: '0x7bB2ADeDdC342ffb611dDC073095cc4B8C547170',
  arbitrum: '0x03fD5BE9DF85F0017dC7F4DC3068dDF64fffF25e',
  optimism: '0xbd7db3821806bc72D223F0AE521Bf82FcBd6Ef4d',
  moonbeam: '0x594203849E52BF6ee0E511cD807Ca2D658893e37',
  gnosis: '0x0Ac72fBc82c9c39F81242229631dfC38aA13031B',
  inevm: '0x77F3863ea99F2360D84d4BA1A2E441857D0357fa', // caldera + injective
  base: '0x3949eD0CD036D9FF662d97BD7aC1686051c4aeBF',
  scroll: '0x6EeEbB9F7FB18DD5E59F82658c59B846715eD4F7',
  polygonzkevm: '0x1610f578D4d77Fc4ae7ce2DD9AA0b98A5Cd0a9b2',
  // injective: 'inj1632x8j35kenryam3mkrsez064sqg2y2fr0frzt',
  // solana: 'EzppBFV2taxWw8kEjxNYvby6q7W1biJEqwP3iC7YgRe3',
  blast: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  linea: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  mode: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  ancient8: '0xD2BFA0F0654E3f2139b8cDC56c32eeC54D32b133',
  taiko: '0xa4864301d3fa2a3e68256309F9F0F570270a1BD0',
  fraxtal: '0x66e9f52800E9F89F0569fddc594Acd5EE609f762',
  sei: '0xCed197FBc360C26C19889745Cf73511b71D03d5D',
  redstone: '0xa1a50ff5FD859558E1899fEC5C3064483177FA23',
  mantle: '0x8aFE6EECc6CcB02aA20DA8Fff7d29aadEBbc2DCd',
  bob: '0x9e2fe7723b018d02cDE4f5cC1A9bC9C65b922Fc8',
  zetachain: '0x9d399876522Fc5C044D048594de399A2349d6026',
  zoramainnet: '0xF87018025575552889062De4b05bBC3DAe35Cd96',
  fusemainnet: '0x29a526227CB864C90Cf078d03872da913B473139',
  endurance: '0xaCD1865B262C89Fb0b50dcc8fB095330ae8F35b5',
  zircuit: '0x9e2fe7723b018d02cDE4f5cC1A9bC9C65b922Fc8',
  swell: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',

  // Q5, 2024 batch
  berachain: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',

  // HyperEVM
  hyperevm: '0x5F7771EA40546e2932754C263455Cb0023a55ca7',

  // zksync chains
  zeronetwork: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',
  abstract: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',
  zksync: '0x9C81aA0cC233e9BddeA426F5d395Ab5B65135450',
  zklink: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',
  treasure: '0xCB21F61A3c8139F18e635d45aD1e62A4A61d2c3D',
  sophon: '0x3D1baf8cA4935f416671640B1Aa9E17E005986eE',
};

export const icaOwnerChain = 'ethereum';

// Found by running:
// yarn tsx ./scripts/keys/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --destinationChains <chain1> <chain2> ...
export const icas: Partial<
  Record<(typeof supportedChainNames)[number], Address>
> = {
  viction: '0x23ed65DE22ac29Ec1C16E75EddB0cE3A187357b4',
  inevm: '0xFDF9EDcb2243D51f5f317b9CEcA8edD2bEEE036e',

  // Jul 26, 2024 batch
  // ----------------------------------------------------------
  xlayer: '0x1571c482fe9E76bbf50829912b1c746792966369',
  cheesechain: '0xEe2C5320BE9bC7A1492187cfb289953b53E3ff1b',
  worldchain: '0x1996DbFcFB433737fE404F58D2c32A7f5f334210',
  // zircuit: '0x0d67c56E818a02ABa58cd2394b95EF26db999aA3', // already has a safe

  // Aug 5, 2024 batch
  // ----------------------------------------------------------
  cyber: '0x984Fe5a45Ac4aaeC4E4655b50f776aB79c9Be19F',
  degenchain: '0x22d952d3b9F493442731a3c7660aCaD98e55C00A',
  kroma: '0xc1e20A0D78E79B94D71d4bDBC8FD0Af7c856Dd7A',
  lisk: '0x22d952d3b9F493442731a3c7660aCaD98e55C00A',
  lukso: '0xc1e20A0D78E79B94D71d4bDBC8FD0Af7c856Dd7A',
  merlin: '0xCf867cEaeeE8CBe65C680c734D29d26440931D5b',
  metis: '0xb51e63CD0842D670a13c88B159fCFc268DA652A3',
  mint: '0xb51e63CD0842D670a13c88B159fCFc268DA652A3',
  proofofplay: '0xb51e63CD0842D670a13c88B159fCFc268DA652A3',
  real: '0xc761e68BF3A94326FD0D305e3ccb4cdaab2edA19',
  sanko: '0x5DAcd2f1AafC749F2935A160865Ab1568eC23752',
  tangle: '0xCC2aeb692197C7894E561d31ADFE8F79746f7d9F',
  xai: '0x22d952d3b9F493442731a3c7660aCaD98e55C00A',
  // taiko: '0x483D218D2FEe7FC7204ba15F00C7901acbF9697D', // renzo chain

  // Aug 26, 2024 batch
  // ----------------------------------------------------------
  astar: '0x6b241544eBa7d89B51b72DF85a0342dAa37371Ca',
  astarzkevm: '0x526c6DAee1175A1A2337E703B63593acb327Dde4',
  bitlayer: '0xe6239316cA60814229E801fF0B9DD71C9CA29008',
  coredao: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  dogechain: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  flare: '0x689b8DaBBF2f9Fd83D37427A062B30edF463e20b',
  molten: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  shibarium: '0x6348FAe3a8374dbAAaE84EEe5458AE4063Fe2be7',

  // Sep 9, 2024 batch
  // ----------------------------------------------------------
  everclear: '0x63B2075372D6d0565F51210D0A296D3c8a773aB6',
  oortmainnet: '0x7021D11F9fAe455AB2f45D72dbc2C64d116Cb657',

  // Sep 19, 2024 SAFE --> ICA v1 Migration
  // ----------------------------------------------------------
  celo: '0x3fA264c58E1365f1d5963B831b864EcdD2ddD19b',
  avalanche: '0x8c8695cD9905e22d84E466804ABE55408A87e595',
  polygon: '0xBDD25dd5203fedE33FD631e30fEF9b9eF2598ECE',
  moonbeam: '0x480e5b5De6a29F07fe8295C60A1845d36b7BfdE6',
  gnosis: '0xD42125a4889A7A36F32d7D12bFa0ae52B0AD106b',
  scroll: '0x2a3fe2513F4A7813683d480724AB0a3683EfF8AC',
  polygonzkevm: '0x66037De438a59C966214B78c1d377c4e93a5C7D1',
  ancient8: '0xA9FD5BeB556AB1859D7625B381110a257f56F98C',
  redstone: '0x5DAcd2f1AafC749F2935A160865Ab1568eC23752',
  mantle: '0x08C880b88335CA3e85Ebb4E461245a7e899863c9',
  bob: '0xc99e58b9A4E330e2E4d09e2c94CD3c553904F588',
  zetachain: '0xc876B8e63c3ff5b636d9492715BE375644CaD345',
  zoramainnet: '0x84977Eb15E0ff5824a6129c789F70e88352C230b',
  fusemainnet: '0xbBdb1682B2922C282b56DD716C29db5EFbdb5632',
  endurance: '0x470E04D8a3b7938b385093B93CeBd8Db7A1E557C',
  // sei: '0xabad187003EdeDd6C720Fc633f929EA632996567', // renzo chain

  // Oct 16, 2024 batch
  // ----------------------------------------------------------
  // lumia: '0x418E10Ac9e0b84022d0636228d05bc74172e0e41',

  // Oct 30, 2024 batch
  // ----------------------------------------------------------
  apechain: '0xe68b0aB6BB8c11D855556A5d3539524f6DB3bdc6',
  arbitrumnova: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  b3: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  fantom: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  gravity: '0x3104ADE26e21AEbdB325321433541DfE8B5dCF23',
  harmony: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  kaia: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  morph: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  orderly: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  snaxchain: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',

  // Nov 8, 2024 batch
  // ----------------------------------------------------------
  alephzeroevmmainnet: '0xDE91AC081E12107a033728A287b06B1Fc640A637',
  chilizmainnet: '0x54AF0FCDCD58428f8dF3f825267DfB58f2C710eb',
  flowmainnet: '0x65528D447C93CC1A1A7186CB4449d9fE0d5C1928',
  immutablezkevmmainnet: '0x54AF0FCDCD58428f8dF3f825267DfB58f2C710eb',
  metal: '0xf1d25462e1f82BbF25b3ef7A4C94F738a30a968B',
  polynomialfi: '0x6ACa36E710dC0C80400090EA0bC55dA913a3D20D',
  rarichain: '0xD0A4Ad2Ca0251BBc6541f8c2a594F1A82b67F114',
  rootstockmainnet: '0x0C15f7479E0B46868693568a3f1C747Fdec9f17d',
  superpositionmainnet: '0x5F17Dc2e1fd1371dc6e694c51f22aBAF8E27667B',
  flame: '0x4F3d85360840497Cd1bc34Ca55f27629eee2AA2e',
  prom: '0x1cDd3C143387cD1FaE23e2B66bc3F409D073aC3D',

  // Nov 21, 2024 batch
  // ----------------------------------------------------------
  boba: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  duckchain: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  unichain: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  vana: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',
  bsquared: '0xd9564EaaA68A327933f758A54450D3A0531E60BB',
  superseed: '0x29dfa34765e29ea353FC8aB70A19e32a5578E603',

  // Dec 4, 2024 batch
  // ----------------------------------------------------------
  // swell: '0xff8326468e7AaB51c53D3569cf7C45Dd54c11687', // already has a safe
  lumiaprism: '0xAFfA863646D1bC74ecEC0dB1070f069Af065EBf5',
  appchain: '0x4F25DFFd10A6D61C365E1a605d07B2ab0E82A7E6',

  // Dec 13, 2024 batch
  // ----------------------------------------------------------
  arthera: '0x962e4E5F5e47e1Ab5361eE0B5108Ebeb9Fa5c99B',
  aurora: '0x853f40c807cbb08EDd19B326b9b6A669bf3c274c',
  conflux: '0xac8f0e306A126312C273080d149ca01d461603FE',
  conwai: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  corn: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  evmos: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  form: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  ink: '0xDde4Ce691d1c0579d48BCdd3491aA71472b6cC38',
  rivalz: '0xc1e20A0D78E79B94D71d4bDBC8FD0Af7c856Dd7A',
  soneium: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  sonic: '0x5926599B8Aff45f1708b804B30213babdAD78C83',
  telos: '0xDde4Ce691d1c0579d48BCdd3491aA71472b6cC38',

  // Jan 13, 2025 batch
  // ----------------------------------------------------------
  artela: '0x745CEA119757ea3e27093da590bC91f408bD4448',
  guru: '0x825cF3d703F384E4aA846BA72eCf70f1985C91b6',
  hemi: '0x8D18CBB212920e5ef070b23b813d82F8981cC276',
  nero: '0xbBdb1682B2922C282b56DD716C29db5EFbdb5632',
  torus: '0xc1e20A0D78E79B94D71d4bDBC8FD0Af7c856Dd7A',
  xpla: '0x24832680dF0468967F413be1C83acfE24154F88D',

  // Feb 3, 2025 batch
  // ----------------------------------------------------------
  glue: '0x24832680dF0468967F413be1C83acfE24154F88D',
  matchain: '0x66af72e46b3e8DFc19992A2A88C05d9EEFE01ffB',
  unitzero: '0x66af72e46b3e8DFc19992A2A88C05d9EEFE01ffB',
  trumpchain: '0x56895bFa7f7dFA5743b2A0994B5B0f88b88350F9',

  // Q5, 2024 batch
  // ----------------------------------------------------------
  // berachain: '0x56895bFa7f7dFA5743b2A0994B5B0f88b88350F9',

  // Feb 17, 2025 batch
  // ----------------------------------------------------------
  bouncebit: '0x8768A14AA6eD2A62C77155501E742376cbE97981',
  arcadia: '0xD2344a364b6Dc6B2Fe0f7D836fa344d83056cbaD',
  ronin: '0x8768A14AA6eD2A62C77155501E742376cbE97981',
  story: '0x8768A14AA6eD2A62C77155501E742376cbE97981',
  subtensor: '0x61BFbb5FEC57f5470388A80946F0415138630b9c',
} as const;

export const DEPLOYER = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

export const ethereumChainOwners: ChainMap<OwnableConfig> = Object.fromEntries(
  ethereumChainNames.map((local) => {
    const owner = icas[local] ?? safes[local] ?? DEPLOYER;

    return [
      local,
      {
        owner,
        ownerOverrides: {
          proxyAdmin: upgradeTimelocks[local] ?? owner,
          validatorAnnounce: DEPLOYER, // unused
          testRecipient: DEPLOYER,
          fallbackRoutingHook: DEPLOYER,
          // Because of the logic above of setting the owner to the Safe or ICA address,
          // the checker/governor tooling does not know what type of owner it is.
          // So we need to keep the Safe and ICA addresses somewhere in the config
          // to be able to track down which addresses are SAFEs, ICAs, or standard SIGNERS.
          ...(safes[local] && { _safeAddress: safes[local] }),
          ...(icas[local] && { _icaAddress: icas[local] }),
        },
      },
    ];
  }),
);

export const chainOwners: ChainMap<OwnableConfig> = {
  ...ethereumChainOwners,
  solanamainnet: {
    // Squads multisig
    owner: 'BNGDJ1h9brgt6FFVd8No1TVAH48Fp44d7jkuydr1URwJ',
  },
  eclipsemainnet: {
    // Squads multisig
    owner: 'E4TncCw3WMqQZbkACVcomX3HqcSzLfNyhTnqKN1DimGr',
  },
  injective: {
    // Native multisig
    owner: 'inj1ac6qpt57vhtfzdecd2an052elwgenwtxcn9chl',
  },
  neutron: {
    // Da0Da0 multisig
    owner: 'neutron1fqf5mprg3f5hytvzp3t7spmsum6rjrw80mq8zgkc0h6rxga0dtzqws3uu7',
  },
  // We intentionally cause issues if these were to be used, but satisfy the types
  // and ensure there's an entry for each supported chain.
  stride: {
    owner: 'n/a - nothing owned here',
  },
  osmosis: {
    owner: 'n/a - nothing owned here',
  },
  soon: {
    // Squads vault
    owner: 'E3QPSn2Upk2EiidSsUqSQpRCc7BhzWZCKpVncemz3p62',
  },
  sonicsvm: {
    // Will move to a Squads once it's live
    owner: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
  },
};
