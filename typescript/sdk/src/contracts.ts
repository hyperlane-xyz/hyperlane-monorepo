import { BaseContract, ethers } from 'ethers';

import { types } from '@abacus-network/utils';

import { ProxiedContract, ProxyAddresses, isProxyAddresses } from './proxy';
import { Connection } from './types';
import { objMap } from './utils';

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

export function deepSerialize(
  contractOrObject: AbacusContracts,
): AbacusAddresses {
  return objMap(
    contractOrObject,
    (_, contract): string | ProxyAddresses<any> | AbacusAddresses => {
      if (contract instanceof BaseContract) {
        return contract.address;
      } else if (contract instanceof ProxiedContract) {
        return contract.addresses;
      } else {
        return deepSerialize(contract);
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
): AbacusContracts {
  return objMap(
    addressOrObject,
    (key, address): ProxiedContract<any, any> | AbacusContracts => {
      if (typeof address === 'string') {
        return getFactory(key, factories).attach(address);
      } else if (isProxyAddresses(address)) {
        const contract = getFactory(key, factories).attach(address.proxy);
        return new ProxiedContract(contract, address);
      } else {
        return buildContracts(address as AbacusAddresses, factories);
      }
    },
  );
}

export function connectContracts<Contracts extends AbacusContracts>(
  contractOrObject: Contracts,
  connection: Connection,
): Contracts {
  return objMap(contractOrObject, (_, contract) => {
    if (
      contract instanceof BaseContract ||
      contract instanceof ProxiedContract
    ) {
      return contract.connect(connection);
    } else {
      return connectContracts(contract, connection);
    }
  }) as Contracts;
}
