import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseAppAdapter } from '../../app/MultiProtocolApp';
import { ChainName } from '../../types';
import { RouterAddress } from '../types';

export interface IRouterAdapter<
  ContractAddrs extends RouterAddress = RouterAddress,
> extends BaseAppAdapter<ContractAddrs> {
  interchainSecurityModule(chain: ChainName): Promise<Address>;
  owner: (chain: ChainName) => Promise<Address>;
  remoteDomains(originChain: ChainName): Promise<Domain[]>;
  remoteRouter: (
    originChain: ChainName,
    remoteDomain: Domain,
  ) => Promise<Address>;
  remoteRouters: (
    originChain: ChainName,
  ) => Promise<Array<{ domain: Domain; address: Address }>>;
}

export interface IGasRouterAdapter<
  ContractAddrs extends RouterAddress = RouterAddress,
> extends IRouterAdapter<ContractAddrs> {
  quoteGasPayment: (
    origin: ChainName,
    destination: ChainName,
  ) => Promise<string>;
}
