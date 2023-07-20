import type { types } from '@hyperlane-xyz/utils';

import { MultiProtocolApp } from '../app/MultiProtocolApp';
import { AddressesMap } from '../contracts/types';
import { ChainMap, ChainName } from '../types';
import { promiseObjAll } from '../utils/objects';

import { IGasRouterAdapter, IRouterAdapter } from './adapters/types';

export { Router } from '@hyperlane-xyz/core';

type RouterAddressesMap = AddressesMap & {
  router: types.Address;
};

export class MultiProtocolRouterApp<
  ContractAddresses extends RouterAddressesMap,
  IAdapterApi extends IRouterAdapter,
> extends MultiProtocolApp<ContractAddresses, IAdapterApi> {
  router(chain: ChainName): types.Address {
    return this.metadata(chain).router;
  }

  interchainSecurityModules(): Promise<ChainMap<types.Address>> {
    return promiseObjAll(
      this.map((chain, adapter) => adapter.interchainSecurityModule(chain)),
    );
  }

  owners(): Promise<ChainMap<types.Address>> {
    return promiseObjAll(this.map((chain, adapter) => adapter.owner(chain)));
  }

  remoteRouters(
    originChain: ChainName,
  ): Promise<Array<{ domain: types.Domain; address: types.Address }>> {
    return this.adapter(originChain).remoteRouters(originChain);
  }
}

export class MultiProtocolGasRouterApp<
  ContractAddresses extends RouterAddressesMap,
  IAdapterApi extends IGasRouterAdapter,
> extends MultiProtocolRouterApp<ContractAddresses, IAdapterApi> {
  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<string> {
    return this.adapter(origin).quoteGasPayment(origin, destination);
  }
}
