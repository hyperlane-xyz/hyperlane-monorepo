import type { Connection } from '@solana/web3.js';
import type { providers } from 'ethers';
import type { Provider as Ev6Provider } from 'ethers6';
import type { PublicClient } from 'viem';

export enum ProviderType {
  EthersV5 = 'ethers-v5',
  EthersV6 = 'ethers-v6',
  Viem = 'viem',
  SolanaWeb3 = 'solana-web3',
}

export type ProviderMap<Value> = Partial<Record<ProviderType, Value>>;

interface TypedProviderBase<T> {
  type: ProviderType;
  provider: T;
}

export interface EthersV5Provider
  extends TypedProviderBase<providers.Provider> {
  type: ProviderType.EthersV5;
  provider: providers.Provider;
}

export interface EthersV6Provider extends TypedProviderBase<Ev6Provider> {
  type: ProviderType.EthersV6;
  provider: Ev6Provider;
}

export interface ViemProvider extends TypedProviderBase<PublicClient> {
  type: ProviderType.Viem;
  provider: PublicClient;
}

export interface SolanaWeb3Provider extends TypedProviderBase<Connection> {
  type: ProviderType.SolanaWeb3;
  provider: Connection;
}

export type TypedProvider =
  | EthersV5Provider
  | EthersV6Provider
  | ViemProvider
  | SolanaWeb3Provider;
