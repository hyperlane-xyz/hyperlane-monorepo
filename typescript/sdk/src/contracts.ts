import { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { MultiProvider } from './providers/MultiProvider';
import { ChainMap, Connection } from './types';
import { objFilter, objMap } from './utils/objects';

export type HyperlaneFactories = {
  [key: string]: ethers.ContractFactory;
};

/*
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
*/

export type HyperlaneContracts<Factories extends HyperlaneFactories> = {
  [Property in keyof Factories]: Awaited<
    ReturnType<Factories[Property]['deploy']>
  >;
};

export type HyperlaneAddresses<Factories extends HyperlaneFactories> = {
  [Property in keyof Factories]: types.Address;
};

export function serializeContracts<F extends HyperlaneFactories>(
  contractOrObject: HyperlaneContracts<F>,
): HyperlaneAddresses<F> {
  return objMap(contractOrObject, (_, contract): string => {
    return contract.address;
  }) as HyperlaneAddresses<F>;
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

export function filterAddresses<F extends HyperlaneFactories>(
  addresses: HyperlaneAddresses<F>,
  contractNames: string[],
): HyperlaneAddresses<any> {
  const isIncluded = (
    name: string,
    address: types.Address,
  ): address is types.Address => {
    return contractNames.includes(name);
  };
  return objFilter(addresses, isIncluded);
}

export function buildContracts<F extends HyperlaneFactories>(
  addresses: HyperlaneAddresses<F>,
  factories: F,
  filter = true,
): HyperlaneContracts<F> {
  if (filter) {
    addresses = filterAddresses(addresses, Object.keys(factories));
  }

  return objMap(addresses, (key, address: types.Address) => {
    return getFactory(key, factories).attach(address);
  }) as HyperlaneContracts<F>;
}

export function connectContracts<F extends HyperlaneFactories>(
  contracts: HyperlaneContracts<F>,
  connection: Connection,
): HyperlaneContracts<F> {
  return objMap(contracts, (_, contract) =>
    contract.connect(connection),
  ) as HyperlaneContracts<F>;
}

export function connectContractsMap<F extends HyperlaneFactories>(
  contractsMap: ChainMap<HyperlaneContracts<F>>,
  multiProvider: MultiProvider,
): ChainMap<HyperlaneContracts<F>> {
  return objMap(contractsMap, (chain, contracts) =>
    connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
  );
}
