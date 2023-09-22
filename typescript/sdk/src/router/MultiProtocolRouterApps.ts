import { Address, Domain, ProtocolType } from '@hyperlane-xyz/utils';

import { AdapterClassType, MultiProtocolApp } from '../app/MultiProtocolApp';
import { ChainMap, ChainName } from '../types';

import {
  EvmGasRouterAdapter,
  EvmRouterAdapter,
} from './adapters/EvmRouterAdapter';
import {
  SealevelGasRouterAdapter,
  SealevelRouterAdapter,
} from './adapters/SealevelRouterAdapter';
import { IGasRouterAdapter, IRouterAdapter } from './adapters/types';
import { RouterAddress } from './types';

export { Router } from '@hyperlane-xyz/core';

export class MultiProtocolRouterApp<
  IAdapterApi extends IRouterAdapter = IRouterAdapter,
  ContractAddrs extends RouterAddress = RouterAddress,
> extends MultiProtocolApp<IAdapterApi, ContractAddrs> {
  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<IAdapterApi> {
    // Casts are required here to allow for default adapters while still
    // enabling extensible generic types
    if (protocol === ProtocolType.Ethereum) return EvmRouterAdapter as any;
    if (protocol === ProtocolType.Sealevel) return SealevelRouterAdapter as any;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  router(chain: ChainName): Address {
    return this.addresses[chain].router;
  }

  interchainSecurityModules(): Promise<ChainMap<Address>> {
    return this.adapterMap((_, adapter) => adapter.interchainSecurityModule());
  }

  owners(): Promise<ChainMap<Address>> {
    return this.adapterMap((_, adapter) => adapter.owner());
  }

  remoteRouters(
    origin: ChainName,
  ): Promise<Array<{ domain: Domain; address: Address }>> {
    return this.adapter(origin).remoteRouters();
  }
}

export class MultiProtocolGasRouterApp<
  IAdapterApi extends IGasRouterAdapter = IGasRouterAdapter,
  ContractAddrs extends RouterAddress = RouterAddress,
> extends MultiProtocolRouterApp<IAdapterApi, ContractAddrs> {
  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<IAdapterApi> {
    // Casts are required here to allow for default adapters while still
    // enabling extensible generic types
    if (protocol === ProtocolType.Ethereum) return EvmGasRouterAdapter as any;
    if (protocol === ProtocolType.Sealevel)
      return SealevelGasRouterAdapter as any;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<string> {
    return this.adapter(origin).quoteGasPayment(destination);
  }
}
