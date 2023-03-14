import { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { ProxiedContract, ProxyAddresses, isProxyAddresses } from './proxy';
import { Connection } from './types';
import { objMap } from './utils/objects';

export type HyperlaneFactories = {
  [key: string]: ethers.ContractFactory;
};

export type HyperlaneContract =
  | ethers.Contract
  | ProxiedContract<any, any>
  | HyperlaneContracts;

export type HyperlaneContracts = {
  [key: Exclude<string, 'address'>]: HyperlaneContract;
};

export type HyperlaneAddresses = {
  [key: string]: types.Address | ProxyAddresses<any> | HyperlaneAddresses;
};

export function serializeContracts(
  contractOrObject: HyperlaneContracts,
  max_depth = 5,
): HyperlaneAddresses {
  if (max_depth === 0) {
    throw new Error('serializeContracts tried to go too deep');
  }
  return objMap(
    contractOrObject,
    (_, contract: any): string | ProxyAddresses<any> | HyperlaneAddresses => {
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
  factories: HyperlaneFactories,
): ethers.ContractFactory {
  if (!(key in factories)) {
    throw new Error(`Factories entry missing for ${key}`);
  }
  return factories[key];
}

// TODO: Support for recursive filtering
export function filterContracts(
  addressOrObject: HyperlaneAddresses,
  factories: HyperlaneFactories,
): HyperlaneAddresses {
  return Object.fromEntries(
    Object.entries(addressOrObject).filter(([k, v]) =>
      Object.keys(factories).includes(k),
    ),
  );
}

export function buildContracts(
  addressOrObject: HyperlaneAddresses,
  factories: HyperlaneFactories,
  max_depth = 5,
): HyperlaneContracts {
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
        address as HyperlaneAddresses,
        factories,
        max_depth - 1,
      );
    }
  });
}

export function connectContracts<Contracts extends HyperlaneContracts>(
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
