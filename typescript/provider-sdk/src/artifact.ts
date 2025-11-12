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
export interface ArtifactFactory<
  AT extends Record<string, ArtifactType>,
  K extends keyof AT,
> {
  readerFromProvider: (provider: IProvider) => ArtifactReader<AT[K]>;
  readerFromProtocolReader: (reader: ProtocolReader) => ArtifactReader<AT[K]>;
  writerFromProtocolWriter: (writer: ProtocolWriter) => ArtifactWriter<AT[K]>;
  moduleFactory: (
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ) => HypModuleFactory<Config<AT[K]>, AddressMap<AT[K]>>;
}

export type ArtifactFactories<AT extends Record<string, ArtifactType>> = {
  [K in keyof AT]?: ArtifactFactory<AT, K>;
};

// Provider interface

export interface ArtifactProvider<AT extends Record<string, ArtifactType>> {
  availableTypes(): () => Set<keyof AT>;
  readerFromProvider(
    provider: IProvider,
  ): <K extends keyof AT>(type: K) => ArtifactReader<AT[K]>;
  readerFromProtocolReader(
    reader: ProtocolReader,
  ): <K extends keyof AT>(type: K) => ArtifactReader<AT[K]>;
  writerFromProtocolWriter(
    writer: ProtocolWriter,
  ): <K extends keyof AT>(type: K) => ArtifactWriter<AT[K]>;
  moduleFactory(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): <K extends keyof AT>(
    type: K,
  ) => HypModuleFactory<Config<AT[K]>, AddressMap<AT[K]>>;
}

export function createArtifactProvider<AT extends Record<string, ArtifactType>>(
  factories: ArtifactFactories<AT>,
): ArtifactProvider<AT> {
  return {
    availableTypes: () => () => new Set(Object.keys(factories) as (keyof AT)[]),
    readerFromProvider: (provider: IProvider) => {
      const cache = new Map<keyof AT, ArtifactReader<AT[keyof AT]>>();
      return <T extends keyof AT>(type: T) => {
        if (!cache.has(type)) {
          const factory = factories[type];
          if (!factory) {
            throw new Error(`No factory registered for type ${String(type)}`);
          }
          cache.set(type, factory.readerFromProvider(provider));
        }
        return cache.get(type)! as ArtifactReader<AT[T]>;
      };
    },
    readerFromProtocolReader: (reader: ProtocolReader) => {
      const cache = new Map<keyof AT, ArtifactReader<AT[keyof AT]>>();
      return <T extends keyof AT>(type: T) => {
        if (!cache.has(type)) {
          const factory = factories[type];
          if (!factory) {
            throw new Error(`No factory registered for type ${String(type)}`);
          }
          cache.set(type, factory.readerFromProtocolReader(reader));
        }
        return cache.get(type)! as ArtifactReader<AT[T]>;
      };
    },
    writerFromProtocolWriter: (writer: ProtocolWriter) => {
      const cache = new Map<keyof AT, ArtifactWriter<AT[keyof AT]>>();
      return <T extends keyof AT>(type: T) => {
        if (!cache.has(type)) {
          const factory = factories[type];
          if (!factory) {
            throw new Error(`No factory registered for type ${String(type)}`);
          }
          cache.set(type, factory.writerFromProtocolWriter(writer));
        }
        return cache.get(type)! as ArtifactWriter<AT[T]>;
      };
    },
    moduleFactory: (signer: ISigner<AnnotatedTx, TxReceipt>) => {
      const cache = new Map<
        keyof AT,
        HypModuleFactory<Config<AT[keyof AT]>, AddressMap<AT[keyof AT]>>
      >();
      return <T extends keyof AT>(type: T) => {
        if (!cache.has(type)) {
          const factory = factories[type];
          if (!factory) {
            throw new Error(`No factory registered for type ${String(type)}`);
          }
          cache.set(type, factory.moduleFactory(signer));
        }
        return cache.get(type)! as HypModuleFactory<
          Config<AT[T]>,
          AddressMap<AT[T]>
        >;
      };
    },
  };
}
