import { Contract } from 'ethers';

import type { types } from '@hyperlane-xyz/utils';

import { Connection } from './types';

export enum ProxyKind {
  Transparent = 'Transparent',
}

export interface ProxyAddresses<Kind extends ProxyKind> {
  kind: Kind;
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
    // 'implementation' in addresses &&
    'kind' in addresses &&
    Object.keys(ProxyKind).includes((addresses as any).kind)
  );
}

export type TransparentProxyAddresses = ProxyAddresses<ProxyKind.Transparent>;

export class ProxiedContract<
  C extends Contract,
  A extends ProxyAddresses<any>,
> {
  constructor(public readonly contract: C, public readonly addresses: A) {}

  get address(): string {
    return this.contract.address;
  }

  connect(connection: Connection): ProxiedContract<C, A> {
    return new ProxiedContract(
      this.contract.connect(connection) as C,
      this.addresses,
    );
  }
}
