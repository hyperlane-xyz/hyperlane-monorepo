import debug from 'debug';

import { AddressesMap } from '../contracts/types';
import { ChainMetadata } from '../metadata/chainMetadataTypes';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import { ChainMap, ChainName } from '../types';
import { MultiGeneric } from '../utils/MultiGeneric';

/**
 * A version of HyperlaneApp that can support different
 * provider types across different protocol types.
 *
 * Intentionally minimal as it's meant to be extended.
 * Extend this class as needed to add useful methods/properties.
 *
 * @typeParam ContractAddresses - A map of contract names to addresses
 * @typeParam IAdapterApi - The type of the adapters for implementing the app's
 *   functionality across different protocols.
 *
 * @param adapters - A map of chain names to adapter instances (e.g. EvmRouterAdapter)
 * @param multiProvider - A MultiProtocolProvider instance that MUST include the app's
 *   contract addresses in its chain metadata
 * @param logger - A logger instance
 */
export class MultiProtocolApp<
  ContractAddresses extends AddressesMap,
  IAdapterApi,
> extends MultiGeneric<IAdapterApi> {
  constructor(
    public readonly adapters: ChainMap<IAdapterApi>,
    public readonly multiProvider: MultiProtocolProvider<ContractAddresses>,
    public readonly logger = debug('hyperlane:MultiProtocolApp'),
  ) {
    super(adapters);
  }

  adapter(chain: ChainName): IAdapterApi {
    return this.get(chain);
  }

  metadata(chain: ChainName): ChainMetadata<ContractAddresses> {
    return this.multiProvider.getChainMetadata(chain);
  }

  // routeByProtocolType<T>(
  //   chain: ChainName,
  //   protocolToFn: Partial<Record<ProtocolType, (chain: ChainName) => T>>,
  // ): T {
  //   const protocolType = this.multiProvider.getChainMetadata(chain).protocol;
  //   if (!protocolToFn[protocolType])
  //     throw new Error(`No function for protocol ${protocolType} provided`);
  //   return protocolToFn[protocolType]!(chain);
  // }

  // getContracts(chain: ChainName, providerType:ProviderType, factories?: { [key in keyof ContractAddresses]: ()=>any}): { [key in keyof ContractAddresses]: TypedContract} {
  // const addresses = this.getAddresses(chain);
  // if (providerType === ProviderType.EthersV5) {
  //   const connectedContractsMap = objMap(addresses, (chain, contracts) =>
  //     connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
  //   );
  // }
  // }
}
