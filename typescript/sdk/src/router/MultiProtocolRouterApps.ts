import { Address, Domain, ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolApp } from '../app/MultiProtocolApp';
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
  ContractAddrs extends RouterAddress = RouterAddress,
  IAdapterApi extends IRouterAdapter = IRouterAdapter,
> extends MultiProtocolApp<ContractAddrs, IAdapterApi> {
  public override readonly protocolToAdapter = {
    [ProtocolType.Ethereum]: EvmRouterAdapter,
    [ProtocolType.Sealevel]: SealevelRouterAdapter,
  };

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
  public override readonly protocolToAdapter = {
    [ProtocolType.Ethereum]: EvmGasRouterAdapter,
    [ProtocolType.Sealevel]: SealevelGasRouterAdapter,
  };

  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<string> {
    return this.adapter(origin).quoteGasPayment(origin, destination);
  }
}
