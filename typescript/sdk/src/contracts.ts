import { BaseContract, ethers } from 'ethers';

import { types } from '@abacus-network/utils';

import { Connection } from './types';
import { objMap } from './utils';

export type AbacusFactories = {
  [key: string]: ethers.ContractFactory;
};

export type AbacusContracts = {
  [key: Exclude<string, 'address'>]: ethers.Contract | AbacusContracts;
};

export type AbacusAddresses = {
  [key: string]: types.Address | AbacusAddresses;
};

export function addresses(contracts: AbacusContracts): AbacusAddresses {
  return objMap(contracts, (_, contract): string | AbacusAddresses => {
    if (contract instanceof BaseContract) {
      return contract.address;
    } else {
      return addresses(contract);
    }
  });
}

export function attach(
  addresses: AbacusAddresses,
  factories: AbacusFactories,
): AbacusContracts {
  return objMap(addresses, (key, address): AbacusContracts => {
    if (typeof address === 'string') {
      if (!(key in factories)) {
        throw new Error(`Factories entry missing for ${key}`);
      }
      return factories[key].attach(address);
    }
    return attach(address, factories);
  });
}

export function connect(
  contracts: AbacusContracts,
  connection: Connection,
): void {
  for (const [key, contract] of Object.entries(contracts)) {
    if (contract instanceof BaseContract) {
      contract.connect(connection);
    } else {
      connect(contracts[key] as AbacusContracts, connection);
    }
  }
}
