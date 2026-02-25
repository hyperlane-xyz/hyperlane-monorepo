import type { Address } from '@hyperlane-xyz/utils';

import type { ChainMap } from '../types.js';

export type AddressesMap = {
  [key: string]: Address;
};

export type HyperlaneContractLike = {
  address: Address;
  interface: {
    encodeFunctionData(
      functionName: string,
      values?: readonly unknown[],
    ): string;
    encodeDeploy(values?: readonly unknown[]): string;
  };
  attach(address: Address): HyperlaneContractLike;
  connect(connection: unknown): HyperlaneContractLike;
  initialize?: (...args: readonly never[]) => unknown;
  [key: string]: unknown;
};

export type HyperlaneContractFactory<
  TContract extends HyperlaneContractLike = HyperlaneContractLike,
  TDeployArgs extends readonly unknown[] = readonly unknown[],
  TConnection = unknown,
> = {
  deploy(...args: TDeployArgs): Promise<TContract>;
  attach(address: Address): TContract;
  connect(
    connection: TConnection,
  ): HyperlaneContractFactory<TContract, TDeployArgs, TConnection>;
  getDeployTransaction(
    ...args: readonly unknown[]
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
};

export type HyperlaneFactories = {
  [key: string]: HyperlaneContractFactory<
    HyperlaneContractLike,
    readonly unknown[],
    unknown
  >;
};

export type HyperlaneContracts<F extends HyperlaneFactories> = {
  [P in keyof F]: Awaited<ReturnType<F[P]['deploy']>>;
};

export type HyperlaneContractsMap<F extends HyperlaneFactories> = ChainMap<
  HyperlaneContracts<F>
>;

export type HyperlaneAddresses<F extends HyperlaneFactories> = {
  [P in keyof F]: Address;
};

export type HyperlaneAddressesMap<F extends HyperlaneFactories> = ChainMap<
  HyperlaneAddresses<F>
>;
