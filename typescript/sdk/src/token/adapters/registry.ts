import type { Address } from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import type { ChainName } from '../../types.js';

import type { ITokenMetadata } from '../ITokenMetadata.js';
import type { TokenStandard } from '../TokenStandard.js';
import type { IHypTokenAdapter, ITokenAdapter } from './ITokenAdapter.js';

export interface TokenAdapterFactoryArgs {
  multiProvider: MultiProviderAdapter;
  token: ITokenMetadata;
}

export interface HypTokenAdapterFactoryArgs {
  multiProvider: MultiProviderAdapter<{ mailbox?: Address }>;
  token: ITokenMetadata;
  destination?: ChainName;
}

export interface CollateralTokenAdapterFactoryArgs {
  multiProvider: MultiProviderAdapter;
  chainName: ChainName;
  tokenAddress: Address;
}

export type TokenAdapterFactory = (
  args: TokenAdapterFactoryArgs,
) => ITokenAdapter<unknown>;

export type HypTokenAdapterFactory = (
  args: HypTokenAdapterFactoryArgs,
) => IHypTokenAdapter<unknown> | undefined;

export type CollateralTokenAdapterFactory = (
  args: CollateralTokenAdapterFactoryArgs,
) => ITokenAdapter<unknown>;

const registeredTokenAdapterFactories = new Map<
  TokenStandard,
  TokenAdapterFactory
>();
const registeredHypTokenAdapterFactories = new Map<
  TokenStandard,
  HypTokenAdapterFactory
>();
const registeredCollateralTokenAdapterFactories = new Map<
  string,
  CollateralTokenAdapterFactory
>();

export function registerTokenAdapterFactories(
  standards: readonly TokenStandard[],
  factory: TokenAdapterFactory,
): void {
  for (const standard of standards) {
    registeredTokenAdapterFactories.set(standard, factory);
  }
}

export function registerHypTokenAdapterFactories(
  standards: readonly TokenStandard[],
  factory: HypTokenAdapterFactory,
): void {
  for (const standard of standards) {
    registeredHypTokenAdapterFactories.set(standard, factory);
  }
}

export function registerCollateralTokenAdapterFactories(
  protocols: readonly string[],
  factory: CollateralTokenAdapterFactory,
): void {
  for (const protocol of protocols) {
    registeredCollateralTokenAdapterFactories.set(protocol, factory);
  }
}

export function getRegisteredTokenAdapterFactory(
  standard: TokenStandard,
): TokenAdapterFactory | undefined {
  return registeredTokenAdapterFactories.get(standard);
}

export function getRegisteredHypTokenAdapterFactory(
  standard: TokenStandard,
): HypTokenAdapterFactory | undefined {
  return registeredHypTokenAdapterFactories.get(standard);
}

export function getRegisteredCollateralTokenAdapterFactory(
  protocol: string,
): CollateralTokenAdapterFactory | undefined {
  return registeredCollateralTokenAdapterFactories.get(protocol);
}

export function clearRegisteredTokenAdapterFactories(): void {
  registeredTokenAdapterFactories.clear();
}

export function clearRegisteredHypTokenAdapterFactories(): void {
  registeredHypTokenAdapterFactories.clear();
}

export function clearRegisteredCollateralTokenAdapterFactories(): void {
  registeredCollateralTokenAdapterFactories.clear();
}
