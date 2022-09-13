import { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { ProxiedContract, ProxyAddresses, isProxyAddresses } from './proxy';
import { Connection } from './types';
import { objMap } from './utils/objects';

export type AbacusFactories = {
  [key: string]: ethers.ContractFactory;
};

export type AbacusContracts = {
  [key: Exclude<string, 'address'>]:
    | ethers.Contract
    | ProxiedContract<any, any>
    | AbacusContracts;
};

export type AbacusAddresses = {
  [key: string]: types.Address | ProxyAddresses<any> | AbacusAddresses;
};

export function serializeContracts(
  contractOrObject: AbacusContracts,
  max_depth = 5,
): AbacusAddresses {
  if (max_depth === 0) {
    throw new Error('serializeContracts tried to go too deep');
  }
  return objMap(
    contractOrObject,
    (_, contract: any): string | ProxyAddresses<any> | AbacusAddresses => {
      if (contract instanceof ProxiedContract) {
        return contract.addresses;
      } else if (contract.address) {
        return contract.address;
      } else {
        return serializeContracts(contract, max_depth - 1);
      }
    },
  );
}

function getFactory(
  key: string,
  factories: AbacusFactories,
): ethers.ContractFactory {
  if (!(key in factories)) {
    throw new Error(`Factories entry missing for ${key}`);
  }
  return factories[key];
}

export function buildContracts(
  addressOrObject: AbacusAddresses,
  factories: AbacusFactories,
  max_depth = 5,
): AbacusContracts {
  if (max_depth === 0) {
    throw new Error('buildContracts tried to go too deep');
  }
  return objMap(addressOrObject, (key, address: any) => {
    if (isProxyAddresses(address)) {
      const contract = getFactory(key, factories).attach(address.proxy);
      return new ProxiedContract(contract, address);
    } else if (typeof address === 'string') {
      return getFactory(key, factories).attach(address);
    } else {
      return buildContracts(
        address as AbacusAddresses,
        factories,
        max_depth - 1,
      );
    }
  });
}

export function connectContracts<Contracts extends AbacusContracts>(
  contractOrObject: Contracts,
  connection: Connection,
  max_depth = 5,
): Contracts {
  if (max_depth === 0) {
    throw new Error('connectContracts tried to go too deep');
  }
  return objMap(contractOrObject, (_, contract: any) => {
    if (contract.connect) {
      return contract.connect(connection);
    } else {
      return connectContracts(contract, connection, max_depth - 1);
    }
  }) as Contracts;
}
