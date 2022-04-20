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

type AbacusContractFactory<C extends Contract> = (
  address: types.Address,
  connection: Connection,
) => C;

abstract class AbacusAppContracts<A extends AbacusContractAddresses> {
  abstract get _factories(): {
    [key in keyof A]: AbacusContractFactory<any>; // TODO: infer contract type
  };
  contracts: { [key in keyof A]: Contract };
  constructor(public readonly addresses: A, connection: Connection) {
    const contractEntries = Object.entries(addresses).map(([key, addr]) => {
      const factory = this._factories[key];
      const contractAddress = typeof addr === 'string' ? addr : addr.proxy;
      return [key, factory(contractAddress, connection)];
    });
    this.contracts = Object.fromEntries(contractEntries);
  }
}

export type AbacusRouterAddresses = {
  router: Addr;
  xappConnectionManager: Addr;
  upgradeBeaconController: Addr;
};

export abstract class AbacusRouterContracts<
  A extends AbacusContractAddresses,
> extends AbacusAppContracts<A & AbacusRouterAddresses> {
  abstract get factories(): {
    [key in keyof Omit<
      A,
      keyof AbacusRouterAddresses
    >]: AbacusContractFactory<any>;
  };
  get _factories() {
    return {
      router: Router__factory.connect,
      xappConnectionManager: XAppConnectionManager__factory.connect,
      upgradeBeaconController: UpgradeBeaconController__factory.connect,
      ...this.factories,
    } as any;
  }
}
