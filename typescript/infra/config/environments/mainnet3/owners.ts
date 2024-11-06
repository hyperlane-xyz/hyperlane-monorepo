import { AddressesMap, ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { getMainnetAddresses } from '../../registry.js';

import { ethereumChainNames } from './chains.js';
import { supportedChainNames } from './supportedChainNames.js';

export const timelocks: ChainMap<Address | undefined> = {
  arbitrum: '0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01',
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
};

export const icaOwnerChain = 'ethereum';

// Found by running:
// yarn tsx ./scripts/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --destinationChains <chain1> <chain2> ...
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
  // immutablezkevm: '0x8483e1480B62cB9f0aCecEbF42469b9f4013577a',
  // rari: '0x1124D54E989570A798769E534eAFbE1444f40AF6',
  // rootstock: '0x69350aeA98c5195F2c3cC6E6A065d0d8B12F659A',
  // alephzeroevm: '0x004a4C2e4Cd4F5Bd564fe0A6Ab2Da56258aE576f',
  // chiliz: '0xb52D281aD2BA9761c16f400d755837493e2baDB7',
  // lumia: '0x418E10Ac9e0b84022d0636228d05bc74172e0e41',
  // superposition: '0x34b57ff8fBA8da0cFdA795CC0F874FfaB14B1DE9',
  // flow: '0xf48377f8A3ddA7AAD7C2460C81d939434c829b45',
  // metall2: '0x2f1b1B0Fb7652E621316460f6c3b019F61d8dC9a',
  // polynomial: '0xC20eFa1e5A378af9233e9b24515eb3408d43f900',

  // // Oct 30, 2024 batch
  // // ----------------------------------------------------------
  // apechain: '0xe68b0aB6BB8c11D855556A5d3539524f6DB3bdc6',
  // arbitrumnova: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  // b3: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  // fantom: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  // gravity: '0x3104ADE26e21AEbdB325321433541DfE8B5dCF23',
  // harmony: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  // kaia: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  // morph: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  // orderly: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
  // snaxchain: '0x8965d9f19336EB4e910d5f1B9070205FdBee6837',
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
          proxyAdmin: timelocks[local] ?? owner,
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
