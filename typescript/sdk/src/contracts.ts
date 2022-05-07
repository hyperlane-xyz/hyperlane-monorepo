import { Contract } from 'ethers';

import { Router__factory } from '@abacus-network/apps';
import { AbacusConnectionManager__factory } from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { Connection, ProxiedAddress } from './types';

// address types generated from AbacusDeployer deployContract or deployProxiedContract
export type AbacusContractAddresses = {
  [key in string]: ProxiedAddress | types.Address;
};

// from concrete ethers.ContractFactory static connect() type
type EthersFactory<C> = (
  address: types.Address, // TODO: generic on ProxiedAddress for proxy utilities
  connection: Connection,
) => C;
export type Factories<A extends AbacusContractAddresses> = Record<
  keyof A,
  EthersFactory<any>
>;

export interface IAbacusContracts<Addresses, Contracts> {
  readonly addresses: Addresses;
  readonly contracts: Contracts;
  reconnect(connection: Connection): void;
}

export interface ContractsBuilder<
  Addresses,
  Contracts extends IAbacusContracts<Addresses, any>,
> {
  new (addresses: Addresses, connection: Connection): Contracts;
}

export abstract class AbacusContracts<
  A extends AbacusContractAddresses,
  F extends Factories<A> = Factories<A>,
  CM = {
    [key in keyof A]: F[key] extends EthersFactory<infer C> ? C : never;
  },
> implements IAbacusContracts<A, CM>
{
  abstract factories(): F;
  // complexity here allows for subclasses to have strong typing on `this.contracts` inferred
  // from the return types of the factory functions provided to the constructor
  readonly contracts: CM;
  constructor(readonly addresses: A, connection: Connection) {
    const factories = this.factories();
    const contractEntries = Object.entries(addresses).map(([key, addr]) => {
      const contractAddress = typeof addr === 'string' ? addr : addr.proxy;
      return [key, factories[key](contractAddress, connection)];
    });
    this.contracts = Object.fromEntries(contractEntries);
  }

  reconnect(connection: Connection) {
    Object.values(this.contracts).forEach((contract: Contract) =>
      contract.connect(connection),
    );
  }

  protected onlySigner(actual: types.Address, expected: types.Address) {
    if (actual !== expected) {
      throw new Error(`Signer ${actual} must be ${expected} for this method`);
    }
  }
}

export type RouterAddresses = {
  abacusConnectionManager: types.Address;
  router: types.Address;
};

export const routerFactories: Factories<RouterAddresses> = {
  router: Router__factory.connect,
  abacusConnectionManager: AbacusConnectionManager__factory.connect,
};
