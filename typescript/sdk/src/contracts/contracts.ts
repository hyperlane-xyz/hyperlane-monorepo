import { Contract, ethers } from 'ethers';

import { Ownable } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  ValueOf,
  hexOrBase58ToHex,
  objFilter,
  objMap,
  pick,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, Connection } from '../types.js';

import {
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from './types.js';

export function serializeContractsMap<F extends HyperlaneFactories>(
  contractsMap: HyperlaneContractsMap<F>,
): HyperlaneAddressesMap<F> {
  return objMap(contractsMap, (_, contracts) => {
    return serializeContracts(contracts);
  });
}

export function serializeContracts<F extends HyperlaneFactories>(
  contracts: HyperlaneContracts<F>,
): any {
  return objMap(contracts, (_, contract) =>
    contract.address ? contract.address : serializeContracts(contract),
  );
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

export function filterChainMapToProtocol(
  contractsMap: ChainMap<any>,
  protocolType: ProtocolType,
  metadataManager: ChainMetadataManager<any>,
): ChainMap<any> {
  return objFilter(
    contractsMap,
    (c, _addrs): _addrs is any =>
      metadataManager.tryGetChainMetadata(c)?.protocol === protocolType,
  );
}

export function filterChainMapExcludeProtocol(
  contractsMap: ChainMap<any>,
  protocolType: ProtocolType,
  metadataManager: ChainMetadataManager<any>,
): ChainMap<any> {
  return objFilter(
    contractsMap,
    (c, _addrs): _addrs is any =>
      metadataManager.tryGetChainMetadata(c)?.protocol !== protocolType,
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

export function attachContractsMapAndGetForeignDeployments<
  F extends HyperlaneFactories,
>(
  addressesMap: HyperlaneAddressesMap<any>,
  factories: F,
  metadataManager: ChainMetadataManager<any>,
): {
  contractsMap: HyperlaneContractsMap<F>;
  foreignDeployments: ChainMap<Address>;
} {
  const contractsMap = attachContractsMap(
    filterChainMapToProtocol(
      addressesMap,
      ProtocolType.Ethereum,
      metadataManager,
    ),
    factories,
  );

  const foreignDeployments = objMap(
    filterChainMapExcludeProtocol(
      addressesMap,
      ProtocolType.Ethereum,
      metadataManager,
    ),
    (_, addresses) => hexOrBase58ToHex(addresses.router),
  );

  return {
    contractsMap,
    foreignDeployments,
  };
}

export function connectContracts<F extends HyperlaneFactories>(
  contracts: HyperlaneContracts<F>,
  connection: Connection,
): HyperlaneContracts<F> {
  const connectedContracts = objMap(contracts, (_, contract) => {
    if (!contract.connect) {
      return undefined;
    }
    return contract.connect(connection);
  });
  return Object.fromEntries(
    Object.entries(connectedContracts).filter(([_, contract]) => !!contract),
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
  // Hack to accommodate non-Ethereum artifacts, while still retaining their
  // presence in the addressesMap so that they are included in the list of chains
  // on the MultiProvider (needed for getting metadata). A non-Ethereum-style address
  // from another execution environment will cause Ethers to throw if we try to attach
  // it, so we just replace it with the zero address.
  const addressesMapWithEthereumizedAddresses = objMap(
    addressesMap,
    (chain, addresses) => {
      const metadata = multiProvider.getChainMetadata(chain);
      if (metadata.protocol === ProtocolType.Ethereum) {
        return addresses;
      }
      return objMap(
        addresses,
        (_key, _address) => ethers.constants.AddressZero,
      );
    },
  );

  // Attaches contracts for each chain for which we have a complete set of
  // addresses
  const contractsMap = attachContractsMap(
    addressesMapWithEthereumizedAddresses,
    factories,
  );

  // Filters out providers for chains for which we don't have a complete set
  // of addresses
  const intersection = multiProvider.intersect(Object.keys(contractsMap));

  // Filters out contracts for chains for which we don't have a provider
  const filteredContractsMap = pick(contractsMap, intersection.intersection);

  return {
    contractsMap: filteredContractsMap,
    multiProvider: multiProvider,
  };
}
