import { IProvider, ISigner } from './altvm.js';
import { ProtocolReader, ProtocolWriter } from './factory.js';
import { AnnotatedTx, type HypModuleFactory, TxReceipt } from './module.js';

// Base types
export interface ArtifactType {
  config: unknown;
  derived: unknown;
  addresses: Record<string, unknown>;
}

export type Config<T extends { config: unknown }> = T['config'];
export type Derived<T extends { derived: unknown }> = T['derived'];
export type AddressMap<T extends { addresses: Record<string, unknown> }> =
  T['addresses'];

// Transaction primitives
export interface Transaction<T = unknown> {
  type: string;
  data: T;
}

export interface Receipt<T = unknown> {
  hash: string;
  status: string;
  data: T;
}

// Reader/Writer interfaces
export interface ArtifactReader<T extends ArtifactType> {
  read(address: string): Promise<Derived<T>>;
}

export interface ArtifactWriter<T extends ArtifactType> {
  create(config: Config<T>): Promise<Derived<T>>;
  update(
    address: string,
    config: Config<T>,
  ): Promise<{
    derived: Derived<T>;
    receipts: Receipt[];
    transactions: Transaction[];
  }>;
  transferOwnership(address: string, config: Config<T>): Promise<Transaction[]>;
}

// Factory types
export type ArtifactFactory<
  AT extends Record<string, ArtifactType>,
  K extends keyof AT,
> = [
  // readerFromProvider: (provider: IProvider) => ArtifactReader<AT[K]>,
  readerFactory: (reader: ProtocolReader) => ArtifactReader<AT[K]>,
  writerFactory: (writer: ProtocolWriter) => ArtifactWriter<AT[K]>,
  // moduleFactory: (signer: ISigner<AnnotatedTx, TxReceipt>) => HypModuleFactory<Config<AT[K]>, AddressMap<AT[K]>>,
];

export type ArtifactFactories<AT extends Record<string, ArtifactType>> = {
  [K in keyof AT]?: ArtifactFactory<AT, K>;
};

// Provider interface

export interface ArtifactProvider<AT extends Record<string, ArtifactType>> {
  availableTypes(): () => Set<keyof AT>;
  // We don't need overloads, it's better to merge IProvider and ProtocolReader
  createReader(
    provider: IProvider,
  ): <K extends keyof AT>(type: K) => ArtifactReader<AT[K]>;
  createReader(
    reader: ProtocolReader,
  ): <K extends keyof AT>(type: K) => ArtifactReader<AT[K]>;
  createWriter(
    writer: ProtocolWriter,
  ): <K extends keyof AT>(type: K) => ArtifactWriter<AT[K]>;
  // We probably don't need HypModuleFactory and this method either
  createModuleFactory<K extends keyof AT>(
    type: K,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): HypModuleFactory<Config<AT[K]>, AddressMap<AT[K]>>;
}

// To be merged with ArtifactProvider
export interface ArtifactProviderPoc<AT extends Record<string, ArtifactType>> {
  availableTypes(): () => Set<keyof AT>;
  readable(
    reader: ProtocolReader,
  ): <K extends keyof AT>(type: K) => ArtifactReader<AT[K]>;
  writable(
    writer: ProtocolWriter,
  ): <K extends keyof AT>(type: K) => ArtifactWriter<AT[K]>;
}

export function createArtifactProvider<AT extends Record<string, ArtifactType>>(
  factories: ArtifactFactories<AT>,
): ArtifactProviderPoc<AT> {
  return {
    availableTypes: () => () => new Set(Object.keys(factories) as (keyof AT)[]),
    readable: (reader: ProtocolReader) => {
      const cache = new Map<keyof AT, ArtifactReader<AT[keyof AT]>>();
      return <T extends keyof AT>(type: T) => {
        if (!cache.has(type)) {
          const factory = factories[type];
          if (!factory) {
            throw new Error(`No factory registered for type ${String(type)}`);
          }
          const [readerFactory, _] = factory;
          cache.set(type, readerFactory(reader));
        }
        return cache.get(type)! as ArtifactReader<AT[T]>;
      };
    },
    writable: (writer: ProtocolWriter) => {
      const cache = new Map<keyof AT, ArtifactWriter<AT[keyof AT]>>();
      return <T extends keyof AT>(type: T) => {
        if (!cache.has(type)) {
          const factory = factories[type];
          if (!factory) {
            throw new Error(`No factory registered for type ${String(type)}`);
          }
          const [_, writerFactory] = factory;
          cache.set(type, writerFactory(writer));
        }
        return cache.get(type)! as ArtifactWriter<AT[T]>;
      };
    },
  };
}
