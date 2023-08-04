import { Contract } from 'ethers';

import { Ownable } from '@hyperlane-xyz/core';
import {
  Address,
  ValueOf,
  objFilter,
  objMap,
  pick,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, Connection } from '../types';

import {
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from './types';

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
  return objMap(contracts, (_, contract) => contract.address);
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

export function filterAddressesMap<F extends HyperlaneFactories>(
  addressesMap: HyperlaneAddressesMap<any>,
  factories: F,
): HyperlaneAddressesMap<F> {
  const factoryKeys = Object.keys(factories);
  // Filter out addresses that we do not have factories for
  const pickedAddressesMap = objMap(addressesMap, (_, addresses) =>
    pick(addresses, factoryKeys),
  );
  // Filter out chains for which we do not have a complete set of addresses
  return objFilter(
    pickedAddressesMap,
    (_, addresses): addresses is HyperlaneAddresses<F> => {
      return Object.keys(addresses).every((a) => factoryKeys.includes(a));
    },
  );
}

export function attachContracts<F extends HyperlaneFactories>(
  addresses: HyperlaneAddresses<F>,
  factories: F,
): HyperlaneContracts<F> {
  return objMap(addresses, (key, address: Address) => {
    const factory = getFactory(key, factories);
    return factory.attach(address) as Awaited<ReturnType<ValueOf<F>['deploy']>>;
  });
}

export function attachContractsMap<F extends HyperlaneFactories>(
  addressesMap: HyperlaneAddressesMap<any>,
  factories: F,
): HyperlaneContractsMap<F> {
  const filteredAddressesMap = filterAddressesMap(addressesMap, factories);
  return objMap(filteredAddressesMap, (_, addresses) =>
    attachContracts(addresses, factories),
  ) as HyperlaneContractsMap<F>;
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

export function connectContractsMap<F extends HyperlaneFactories>(
  contractsMap: ChainMap<HyperlaneContracts<F>>,
  multiProvider: MultiProvider,
): ChainMap<HyperlaneContracts<F>> {
  return objMap(contractsMap, (chain, contracts) =>
    connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
  );
}

export async function filterOwnableContracts(
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

export function appFromAddressesMapHelper<F extends HyperlaneFactories>(
  addressesMap: HyperlaneAddressesMap<any>,
  factories: F,
  multiProvider: MultiProvider,
): {
  contractsMap: HyperlaneContractsMap<F>;
  multiProvider: MultiProvider;
} {
  // Attaches contracts for each chain for which we have a complete set of
  // addresses
  const contractsMap = attachContractsMap(addressesMap, factories);

  // Filters out providers for chains for which we don't have a complete set
  // of addresses
  const intersection = multiProvider.intersect(Object.keys(contractsMap));

  // Filters out contracts for chains for which we don't have a provider
  const filteredContractsMap = pick(contractsMap, intersection.intersection);

  return {
    contractsMap: filteredContractsMap,
    multiProvider: intersection.multiProvider,
  };
}
