import { Contract, ContractInterface } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { Connection } from './types';

export enum ProxyKind {
  Transparent = 'Transparent',
}

export interface ProxyAddresses<Kind extends ProxyKind> {
  kind: Kind | string;
  proxy: types.Address;
  implementation: types.Address;
}

export function isProxyAddresses(
  addresses: unknown,
): addresses is ProxyAddresses<any> {
  return (
    addresses !== null &&
    typeof addresses === 'object' &&
    'proxy' in addresses &&
    'implementation' in addresses &&
    'kind' in addresses &&
    Object.keys(ProxyKind).includes((addresses as any).kind)
  );
}

export function flattenProxyAddresses(
  addresses?: types.Address | ProxyAddresses<any>,
): undefined | types.Address {
  return isProxyAddresses(addresses) ? addresses.proxy : addresses;
}

export type TransparentProxyAddresses = ProxyAddresses<ProxyKind.Transparent>;

export class ProxiedContract<
  C extends Contract,
  A extends ProxyAddresses<any>,
> extends Contract {
  static fromContract<C extends Contract, A extends ProxyAddresses<any>>(
    contract: C,
    addresses: A,
  ): ProxiedContract<C, A> {
    const signerOrProvider =
      contract.signer == null ? contract.provider : contract.signer;
    return new ProxiedContract(
      contract.address,
      contract.interface,
      signerOrProvider,
      addresses,
    );
  }

  constructor(
    addressOrName: string,
    contractInterface: ContractInterface,
    signerOrProvider: Connection,
    public readonly addresses: A,
  ) {
    super(addressOrName, contractInterface, signerOrProvider);
  }

  connect(connection: Connection): ProxiedContract<C, A> {
    return new ProxiedContract(
      this.address,
      this.interface,
      connection,
      this.addresses,
    );
  }
}
