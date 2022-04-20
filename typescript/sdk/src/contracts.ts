import { Router__factory } from '@abacus-network/apps';
import {
  UpgradeBeaconController__factory,
  XAppConnectionManager__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { Contract } from 'ethers';
import { Connection, ProxiedAddress } from './types';

type Addr = ProxiedAddress | types.Address;

type AbacusContractAddresses = {
  [key: string]: Addr;
};

type AbacusContractFactory = (
  address: types.Address,
  connection: Connection,
) => Contract;

abstract class AbacusAppContracts<A extends AbacusContractAddresses> {
  abstract get _factories(): Record<keyof A, AbacusContractFactory>;
  contracts: Record<keyof A, Contract>; // TODO; infer Contract type from key
  constructor(public readonly addresses: A, connection: Connection) {
    const contractEntries = Object.entries(addresses).map(([key, addr]) => {
      const factory = this._factories[key];
      const contractAddress = typeof addr === 'string' ? addr : addr.proxy;
      return [key, factory(contractAddress, connection)];
    });
    this.contracts = Object.fromEntries(contractEntries);
  }
  reconnect(connection: Connection) {
    Object.values(this.contracts).forEach((contract) =>
      contract.connect(connection),
    );
  }
}

export type AbacusRouterAddresses = {
  router: Addr;
  xappConnectionManager: Addr;
  upgradeBeaconController: Addr;
};

export abstract class AbacusRouterContracts<
  A extends AbacusRouterAddresses,
  O = Omit<A, keyof AbacusRouterAddresses>,
> extends AbacusAppContracts<A> {
  abstract get factories(): Record<keyof O, AbacusContractFactory>;
  get _factories() {
    return {
      router: Router__factory.connect,
      xappConnectionManager: XAppConnectionManager__factory.connect,
      upgradeBeaconController: UpgradeBeaconController__factory.connect,
      ...this.factories,
    } as any; // TODO: remove any
  }
}
