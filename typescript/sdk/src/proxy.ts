import { Contract } from 'ethers';

import { TransparentUpgradeableProxy__factory } from '@hyperlane-xyz/core';
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
  // The presence of `implementation` is intentionally not checked
  // to allow deploying new implementations by deleting the implementation
  // from the artifacts
  return (
    addresses !== null &&
    typeof addresses === 'object' &&
    'proxy' in addresses &&
    'kind' in addresses &&
    Object.keys(ProxyKind).includes((addresses as any).kind)
  );
}

export function getProxyAddress(
  address: types.Address | ProxyAddresses<any>,
): string {
  return isProxyAddresses(address) ? address.proxy : address;
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

  get deployTransaction() {
    return this.contract.deployTransaction;
  }

  get proxy() {
    return TransparentUpgradeableProxy__factory.connect(
      this.address,
      this.contract.signer || this.contract.provider,
    );
  }

  connect(connection: Connection): ProxiedContract<C, A> {
    return new ProxiedContract(
      this.contract.connect(connection) as C,
      this.addresses,
    );
  }
}
