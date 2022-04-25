import { Router__factory } from '@abacus-network/apps';
import { XAppConnectionManager__factory } from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { Contract } from 'ethers';
import { Connection, ProxiedAddress } from './types';

type Addr = ProxiedAddress | types.Address;

// Deploy/Hardhat should generate this upon deploy as JSON
export type AbacusContractAddresses = {
  [key in string]: Addr;
};

type FactoryFunction<C> = (address: types.Address, connection: Connection) => C;
export type Factories<A extends AbacusContractAddresses> = Record<
  keyof A,
  FactoryFunction<Contract>
>;

export interface IAbacusContracts<Contracts> {
  contracts: Contracts;
  reconnect(connection: Connection): void;
}

export abstract class AbacusContracts<
  A extends AbacusContractAddresses,
  F extends Factories<A> = Factories<A>,
  CM = {
    [key in keyof A]: F[key] extends FactoryFunction<infer C> ? C : never;
  },
> implements IAbacusContracts<CM>
{
  abstract factories(): F;
  // complexity here allows for subclasses to have strong typing on `this.contracts` inferred
  // from the return types of the factory functions provided to the constructor
  contracts: CM;
  constructor(addresses: A, connection: Connection) {
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

  protected async onlySigner(actual: types.Address, expected: types.Address) {
    if (actual !== expected) {
      throw new Error(`Signer ${actual} must be ${expected} for this method`);
    }
  }
}

export type RouterAddresses = {
  xAppConnectionManager: Addr;
  router: Addr;
};

export const routerFactories = {
  router: Router__factory.connect,
  xAppConnectionManager: XAppConnectionManager__factory.connect,
};

// type RemoteFunctionName = `${string}Remote${string}`;
// abstract class RouterContract<C extends Router> {
//   abstract factory(): FactoryFunction<C>;
//   router: C;

//   constructor(address: types.Address, connection: Connection) {
//     this.router = this.factory()(address, connection);
//   }

//   protected resolveChainId = (chain: ChainName) => domains[chain].id;

//   // remoteInterface(
//   //   destination: ChainName,
//   //   remoteFunctionName: Extract<keyof C['functions'], RemoteFunctionName>,
//   //   ...remoteParams: Parameters<C['functions'][typeof remoteFunctionName]>
//   // ): ReturnType<C['functions'][typeof remoteFunctionName]> {
//   //   const destinationChainId = this.resolveChainId(destination);
//   //   // @ts-ignore
//   //   return this.router.functions[remoteFunctionName](
//   //     destinationChainId,
//   //     ...remoteParams,
//   //   );
//   // }

//   getRemoteRouter = async (chain: ChainName, multiProvider: MultiProvider) => {
//     const chainId = this.resolveChainId(chain);
//     const routerAddress = await this.router.routers(chainId);
//     const provider = multiProvider.getDomainConnection(chain);
//     return this.factory()(routerAddress, provider.getConnection()!);
//   };

//   // estimateGas = async (
//   //   destinationRouter: RouterContract<C>,
//   //   sender: string,
//   //   message: string,
//   //   overrides?: ethers.Overrides,
//   // ) {
//   //   const originChainId = domains[origin].id;
//   //   return this.router.estimateGas.handle(
//   //     originChainId,
//   //     sender,
//   //     message,
//   //     overrides,
//   //   );
//   // }
// }
