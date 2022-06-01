import { Contract } from 'ethers';

import { types } from '@abacus-network/utils';

import { Connection } from './types';

enum ProxyKind {
  UpgradeBeacon = 'UpgradeBeacon',
}

export interface ProxyAddresses<Kind extends ProxyKind> {
  kind: Kind;
  proxy: types.Address;
  implementation: types.Address;
}

export function isProxyAddresses(
  addresses: object,
): addresses is ProxyAddresses<ProxyKind> {
  return (
    'proxy' in addresses &&
    'implementation' in addresses &&
    'kind' in addresses &&
    Object.values(ProxyKind).includes((addresses as any).kind)
  );
}

export interface BeaconProxyAddresses
  extends ProxyAddresses<ProxyKind.UpgradeBeacon> {
  beacon: types.Address;
}

export class ProxiedContract<C extends Contract, K extends ProxyKind> {
  constructor(
    public readonly contract: C,
    public readonly addresses: ProxyAddresses<K>,
  ) {}

  get address(): string {
    return this.contract.address;
  }

  connect(connection: Connection): ProxiedContract<C, K> {
    return new ProxiedContract(
      this.contract.connect(connection) as C,
      this.addresses,
    );
  }
}
