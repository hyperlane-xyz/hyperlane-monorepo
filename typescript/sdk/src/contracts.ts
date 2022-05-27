import { ethers } from 'ethers';

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
  return objMap(contracts, (_, contract): string | AbacusAddresses =>
    'address' in contract ? contract.address : addresses(contract),
  );
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
    if ('connect' in contract) {
      (contract as ethers.Contract).connect(connection);
    } else {
      connect(contracts[key], connection);
    }
  }
}
