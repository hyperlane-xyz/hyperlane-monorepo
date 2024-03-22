import {
  AddressesMap,
  ChainMap,
  OwnableConfig,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { ethereumChainNames } from './chains';

export const timelocks: ChainMap<Address | undefined> = {
  arbitrum: '0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01',
};

export function localAccountRouters(): ChainMap<Address> {
  const coreAddresses: ChainMap<AddressesMap> =
    hyperlaneEnvironments['mainnet'];
  return Object.fromEntries(
    Object.keys(coreAddresses)
      .filter((local) => coreAddresses[local].interchainAccountRouter)
      .map((local) => [local, coreAddresses[local].interchainAccountRouter]),
  );
}

export const safes: ChainMap<Address | undefined> = {
  mantapacific: '0x03ed2D65f2742193CeD99D48EbF1F1D6F12345B6', // does not have a UI
  celo: '0x1DE69322B55AC7E0999F8e7738a1428C8b130E4d',
  ethereum: '0x12C5AB61Fe17dF9c65739DBa73dF294708f78d23',
  avalanche: '0xDF9B28B76877f1b1B4B8a11526Eb7D8D7C49f4f3',
  polygon: '0x0D195469f76146F6ae3De8fc887e0f0DFBA691e7',
  bsc: '0xA0d3dcB9d61Fba32cc02Ad63983e101b29E2f28a',
  arbitrum: '0xbA47E1b575980B7D1b1508cc48bE1Df4EE508111',
  optimism: '0xb523CFAf45AACF472859f8B793CB0BFDB16bD257',
  moonbeam: '0xF0cb1f968Df01fc789762fddBfA704AE0F952197',
  gnosis: '0x36b0AA0e7d04e7b825D7E409FEa3c9A3d57E4C22',
  inevm: '0x77F3863ea99F2360D84d4BA1A2E441857D0357fa', // caldera + injective
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
      },
    },
  ]),
);
