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
  // -------------------------------------
  xlayer: '0x1571c482fe9E76bbf50829912b1c746792966369',
  cheesechain: '0xEe2C5320BE9bC7A1492187cfb289953b53E3ff1b',
  worldchain: '0x1996DbFcFB433737fE404F58D2c32A7f5f334210',
  // zircuit: '0x0d67c56E818a02ABa58cd2394b95EF26db999aA3', // already has a safe

  // Aug 5, 2024 batch
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
  // taiko: '0x483D218D2FEe7FC7204ba15F00C7901acbF9697D', // already has a safe

  // Aug 26, 2024 batch
  astar: '0x6b241544eBa7d89B51b72DF85a0342dAa37371Ca',
  astarzkevm: '0x526c6DAee1175A1A2337E703B63593acb327Dde4',
  bitlayer: '0xe6239316cA60814229E801fF0B9DD71C9CA29008',
  coredao: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  dogechain: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  flare: '0x689b8DaBBF2f9Fd83D37427A062B30edF463e20b',
  molten: '0x84802CdF47565C95d8ffd59E7c4B1cf027F5452F',
  shibarium: '0x6348FAe3a8374dbAAaE84EEe5458AE4063Fe2be7',

  // Sep 9, 2024 batch
  // ----------------------------
  everclear: '0x63B2075372D6d0565F51210D0A296D3c8a773aB6',
  oortmainnet: '0x7021D11F9fAe455AB2f45D72dbc2C64d116Cb657',
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
