import { ethers } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { MultiProvider } from './providers/MultiProvider';
import { ChainMap, Connection } from './types';
import { objFilter, objMap, pick } from './utils/objects';

export type HyperlaneFactories = {
  [key: string]: ethers.ContractFactory;
};

export type HyperlaneContracts<Factories extends HyperlaneFactories> = {
  [Property in keyof Factories]: Awaited<
    ReturnType<Factories[Property]['deploy']>
  >;
};

export type HyperlaneContractsMap<Factories extends HyperlaneFactories> =
  ChainMap<HyperlaneContracts<Factories>>;

export type HyperlaneAddresses<Factories extends HyperlaneFactories> = {
  [Property in keyof Factories]: types.Address;
};

export type HyperlaneAddressesMap<Factories extends HyperlaneFactories> =
  ChainMap<HyperlaneAddresses<Factories>>;

export function serializeContractsMap<F extends HyperlaneFactories>(
  contractsMap: HyperlaneContractsMap<F>,
): HyperlaneAddressesMap<F> {
  return objMap(contractsMap, (_, contracts) => {
    return serializeContracts(contracts);
  });
}

export function serializeContracts<F extends HyperlaneFactories>(
  contracts: HyperlaneContracts<F>,
): HyperlaneAddresses<F> {
  return objMap(
    contracts,
    (_, contract) => contract.address,
  ) as HyperlaneAddresses<F>;
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

export function filterAddresses(
  addresses: HyperlaneAddresses<any>,
  factories: HyperlaneFactories,
): HyperlaneAddresses<any> {
  return pick(addresses, Object.keys(factories));
}

export function filterAddressesMap<F extends HyperlaneFactories>(
  addressesMap: HyperlaneAddressesMap<any>,
  factories: F,
): HyperlaneAddressesMap<F> {
  const filteredAddressesMap = objMap(addressesMap, (_, addresses) =>
    filterAddresses(addresses, factories),
  );
  return objFilter(
    filteredAddressesMap,
    (_, addresses): addresses is HyperlaneAddresses<F> => {
      return Object.keys(factories).every((contract) =>
        Object.keys(addresses).includes(contract),
      );
    },
  );
}

export function attachContracts<F extends HyperlaneFactories>(
  addresses: HyperlaneAddresses<F>,
  factories: F,
): HyperlaneContracts<F> {
  return objMap(addresses, (key, address: types.Address) => {
    return getFactory(key, factories).attach(address);
  }) as HyperlaneContracts<F>;
}

export function attachContractsMap<F extends HyperlaneFactories>(
  addressesMap: HyperlaneAddressesMap<F>,
  factories: F,
): HyperlaneContractsMap<F> {
  return objMap(addressesMap, (chain, addresses) =>
    attachContracts(addresses, factories),
  );
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
