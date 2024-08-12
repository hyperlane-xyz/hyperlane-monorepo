import { AddressesMap, ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { getMainnetAddresses } from '../../registry.js';

import { ethereumChainNames } from './chains.js';

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
};

export const icaOwnerChain = 'ethereum';

// Found by running:
// yarn tsx ./scripts/get-owner-ica.ts -e mainnet3 --ownerChain ethereum --destinationChain <chain>
export const icas: ChainMap<Address> = {
  viction: '0x23ed65DE22ac29Ec1C16E75EddB0cE3A187357b4',
  // inEVM ownership should be transferred to this ICA, and this should be uncommented
  // inevm: '0xFDF9EDcb2243D51f5f317b9CEcA8edD2bEEE036e',
};

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
        },
      },
    ];
  }),
);
