import { Contract, ethers } from 'ethers';

import { Ownable } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { MultiProvider } from './providers/MultiProvider';
import { ChainMap, Connection } from './types';
import {
  ValueOf,
  objFilter,
  objMap,
  partialObjMap,
  pick,
  promiseObjAll,
} from './utils/objects';

export type HyperlaneFactories = {
  [key: string]: ethers.ContractFactory;
};

export type HyperlaneContracts<Factories extends HyperlaneFactories> = {
  [Property in keyof Factories]: Awaited<
    ReturnType<Factories[Property]['deploy']>
  >;
};

export type HyperlaneContractsMap<F extends HyperlaneFactories> = ChainMap<
  HyperlaneContracts<F>
>;

export type PartialHyperlaneContracts<F extends HyperlaneFactories> = Partial<
  HyperlaneContracts<F>
>;

export type PartialHyperlaneContractsMap<F extends HyperlaneFactories> =
  ChainMap<PartialHyperlaneContracts<F>>;

export type HyperlaneAddresses<F extends Record<string, any>> = {
  [Property in keyof F]: types.Address;
};

export type HyperlaneAddressesMap<F extends Record<string, any>> = ChainMap<
  HyperlaneAddresses<F>
>;

export type PartialHyperlaneAddresses<F extends Record<string, any>> = Partial<
  HyperlaneAddresses<F>
>;

export type PartialHyperlaneAddressesMap<F extends Record<string, any>> =
  ChainMap<PartialHyperlaneAddresses<F>>;

export function serializeContracts<F extends HyperlaneFactories>(
  contracts: HyperlaneContracts<F>,
): HyperlaneAddresses<F> {
  return objMap(contracts, (_, contract) => contract.address);
}

export function serializeContractsMap<F extends HyperlaneFactories>(
  contractsMap: HyperlaneContractsMap<F>,
): HyperlaneAddressesMap<F> {
  return objMap(contractsMap, (_, contracts) => {
    return serializeContracts<F>(contracts);
  });
}

function getFactory<F extends HyperlaneFactories>(
  key: keyof F,
  factories: F,
): ValueOf<F> {
  if (!(key in factories)) {
    throw new Error(`Factories entry missing for ${key.toString()}`);
  }
  return factories[key];
}

export function filterAddresses<F extends HyperlaneFactories, I extends F>(
  addresses: HyperlaneAddresses<I>,
  factories: F,
): PartialHyperlaneAddresses<F> {
  return pick(
    addresses,
    Object.keys(factories),
  ) as PartialHyperlaneAddresses<F>;
}

export function filterAddressesMap<F extends HyperlaneFactories, I extends F>(
  addressesMap: HyperlaneAddressesMap<I>,
  factories: F,
): PartialHyperlaneAddressesMap<F> {
  return objMap(addressesMap, (_, addresses) =>
    filterAddresses(addresses, factories),
  );
}

export function coerceAddressesMap<F extends HyperlaneFactories, I extends F>(
  addressesMap: HyperlaneAddressesMap<I>,
  factories: F,
): HyperlaneAddressesMap<F> {
  // Filter out addresses that we do not have factories for
  const filteredAddressesMap = filterAddressesMap(addressesMap, factories);

  // Finally, filter out chains for which we do not have a complete set of
  // addresses
  return objFilter(
    filteredAddressesMap,
    (_, addresses): addresses is HyperlaneAddresses<F> => {
      return Object.keys(factories)
        .map((contract) => Object.keys(addresses).includes(contract))
        .every(Boolean);
    },
  );
}

export function attachPartialContracts<F extends HyperlaneFactories>(
  addresses: PartialHyperlaneAddresses<F>,
  factories: F,
): PartialHyperlaneContracts<F> {
  return partialObjMap(addresses, (key, address: types.Address) => {
    const factory = getFactory(key, factories);
    return factory.attach(address) as Awaited<ReturnType<ValueOf<F>['deploy']>>;
  });
}

// TODO: This will not
export function attachPartialContractsMap<F extends HyperlaneFactories>(
  addressesMap: PartialHyperlaneAddressesMap<F>,
  factories: F,
): PartialHyperlaneContractsMap<F> {
  return objMap(addressesMap, (_, addresses) =>
    attachPartialContracts(addresses, factories),
  );
}

export function attachContracts<F extends HyperlaneFactories>(
  addresses: HyperlaneAddresses<F>,
  factories: F,
): HyperlaneContracts<F> {
  return objMap(addresses, (key, address: types.Address) => {
    const factory = getFactory(key, factories);
    return factory.attach(address) as Awaited<ReturnType<ValueOf<F>['deploy']>>;
  });
}

export function attachContractsMap<F extends HyperlaneFactories>(
  addressesMap: HyperlaneAddressesMap<F>,
  factories: F,
): HyperlaneContractsMap<F> {
  return objMap(addressesMap, (_, addresses) =>
    attachContracts(addresses, factories),
  );
}

export function connectContracts<F extends HyperlaneFactories>(
  contracts: HyperlaneContracts<F>,
  connection: Connection,
): HyperlaneContracts<F> {
  return objMap(
    contracts,
    (_, contract) => contract.connect(connection) as typeof contract,
  );
}

export function connectPartialContracts<F extends HyperlaneFactories>(
  contracts: PartialHyperlaneContracts<F>,
  connection: Connection,
): PartialHyperlaneContracts<F> {
  return partialObjMap(
    contracts,
    (_, contract) => contract.connect(connection) as typeof contract,
  );
}

export function connectPartialContractsMap<F extends HyperlaneFactories>(
  contractsMap: PartialHyperlaneContractsMap<F>,
  multiProvider: MultiProvider,
): PartialHyperlaneContractsMap<F> {
  return objMap(contractsMap, (chain, contracts) =>
    connectPartialContracts(
      contracts,
      multiProvider.getSignerOrProvider(chain),
    ),
  );
}

export function connectContractsMap<F extends HyperlaneFactories>(
  contractsMap: HyperlaneContractsMap<F>,
  multiProvider: MultiProvider,
): HyperlaneContractsMap<F> {
  return objMap(contractsMap, (chain, contracts) =>
    connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
  );
}

export async function ownableContracts(
  contracts: HyperlaneContracts<any>,
): Promise<{ [key: string]: Ownable }> {
  const isOwnable = async (_: string, contract: Contract): Promise<boolean> => {
    try {
      await contract.owner();
      return true;
    } catch (_) {
      return false;
    }
  };
  const isOwnableContracts = await promiseObjAll(objMap(contracts, isOwnable));
  return objFilter(
    contracts,
    (name, contract): contract is Ownable => isOwnableContracts[name],
  );
}
