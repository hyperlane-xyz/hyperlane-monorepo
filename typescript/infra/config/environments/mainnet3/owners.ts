import { AddressesMap, ChainMap, OwnableConfig } from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { getMainnetAddresses } from '../../registry.js';

import { ethereumChainNames } from './chains.js';
import { awIcas } from './governance/ica/aw.js';
import { regularIcas } from './governance/ica/regular.js';
import { awSafes } from './governance/safe/aw.js';
import { regularSafes } from './governance/safe/regular.js';

export const upgradeTimelocks: ChainMap<Address | undefined> = {
  arbitrum: '0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01',
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

export const icaOwnerChain = 'ethereum';
export const DEPLOYER = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';

export const ethereumChainOwners: ChainMap<OwnableConfig> = Object.fromEntries(
  ethereumChainNames.map((local) => {
    const owner =
      regularIcas[local] ??
      regularSafes[local] ??
      awIcas[local] ??
      awSafes[local] ??
      DEPLOYER;

    return [
      local,
      {
        owner,
        ownerOverrides: {
          proxyAdmin: upgradeTimelocks[local] ?? owner,
          validatorAnnounce: DEPLOYER, // unused
          testRecipient: DEPLOYER,
          fallbackRoutingHook: DEPLOYER,
        },
      },
    ];
  }),
);

export const chainOwners: ChainMap<OwnableConfig> = {
  ...ethereumChainOwners,
  solanamainnet: {
    // Multisig A
    owner: regularSafes.solanamainnet,
  },
  eclipsemainnet: {
    // Multisig A
    owner: regularSafes.eclipsemainnet,
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
  milkyway: {
    owner: 'TODO: configure milkyway owner',
  },
  soon: {
    // Multisig A
    owner: regularSafes.soon,
  },
  sonicsvm: {
    // Multisig A
    owner: regularSafes.sonicsvm,
  },
};
