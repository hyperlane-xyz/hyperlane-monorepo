import { Address, Domain, ProtocolType } from '@hyperlane-xyz/utils';

import { AdapterClassType, MultiProtocolApp } from '../app/MultiProtocolApp';
import { ChainMap, ChainName } from '../types';

import { EvmRouterAdapter } from './adapters/EvmRouterAdapter';
import { SealevelRouterAdapter } from './adapters/SealevelRouterAdapter';
import { IGasRouterAdapter, IRouterAdapter } from './adapters/types';
import { RouterAddress } from './types';

export { Router } from '@hyperlane-xyz/core';

export class MultiProtocolRouterApp<
  ContractAddrs extends RouterAddress = RouterAddress,
  IAdapterApi extends IRouterAdapter = IRouterAdapter,
> extends MultiProtocolApp<ContractAddrs, IAdapterApi> {
  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<ContractAddrs, IAdapterApi> {
    // Casts are required here to allow for default adapters while still
    // enabling extensible generic types
    if (protocol === ProtocolType.Ethereum) return EvmRouterAdapter as any;
    if (protocol === ProtocolType.Sealevel) return SealevelRouterAdapter as any;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  router(chain: ChainName): Address {
    return this.metadata(chain).router;
  }

  interchainSecurityModules(): Promise<ChainMap<Address>> {
    return this.adapterMap((chain, adapter) =>
      adapter.interchainSecurityModule(chain),
    );
  }

  owners(): Promise<ChainMap<Address>> {
    return this.adapterMap((chain, adapter) => adapter.owner(chain));
  }

  remoteRouters(
    origin: ChainName,
  ): Promise<Array<{ domain: Domain; address: Address }>> {
    return this.adapter(origin).remoteRouters(origin);
  }
}

export class MultiProtocolGasRouterApp<
  ContractAddrs extends RouterAddress = RouterAddress,
  IAdapterApi extends IGasRouterAdapter = IGasRouterAdapter,
> extends MultiProtocolRouterApp<ContractAddrs, IAdapterApi> {
  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<ContractAddrs, IAdapterApi> {
    // Casts are required here to allow for default adapters while still
    // enabling extensible generic types
    if (protocol === ProtocolType.Ethereum) return EvmRouterAdapter as any;
    if (protocol === ProtocolType.Sealevel) return SealevelRouterAdapter as any;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<string> {
    return this.adapter(origin).quoteGasPayment(origin, destination);
  }
}
