import {
  AddressesMap,
  ChainMap,
  OwnableConfig,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { ethereumChainNames } from './chains.js';

export const timelocks: ChainMap<Address | undefined> = {
  arbitrum: '0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01',
};

export function localAccountRouters(): ChainMap<Address> {
  const coreAddresses: ChainMap<AddressesMap> =
    hyperlaneEnvironments['mainnet'];
  const filteredAddresses = objFilter(
    coreAddresses,
    (local, addressMap): addressMap is AddressesMap =>
      addressMap.interchainAccountRouter !== undefined,
  );
  return objMap(
    filteredAddresses,
    (local, addressMap) => addressMap.interchainAccountRouter,
  );
}

export const safes: ChainMap<Address | undefined> = {
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
};

export const DEPLOYER = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

// NOTE: if you wanna use ICA governance, you can do the following:
// const localRouters = localAccountRouters();
// owner: {origin: <HUB_CHAIN>, owner: <SAFE_ADDRESS>, localRouter: localRouters[chain]}
export const owners: ChainMap<OwnableConfig> = Object.fromEntries(
  ethereumChainNames.map((local) => [
    local,
    {
      owner: safes[local] ?? DEPLOYER,
      ownerOverrides: {
        proxyAdmin: timelocks[local] ?? safes[local] ?? DEPLOYER,
        validatorAnnounce: DEPLOYER, // unused
        testRecipient: DEPLOYER,
      },
    },
  ]),
);
