import { WithAddress } from '@hyperlane-xyz/utils';

import { IProvider, ISigner } from './altvm.js';
import { ProtocolReader, ProtocolWriter } from './factory.js';
import {
  AnnotatedTx,
  type ArtifactReaderPoc,
  type ArtifactType,
  type ArtifactWriter,
  HypModuleFactory,
  TxReceipt,
} from './module.js';

export interface ArtifactReader<TConfig> {
  read(address: string): Promise<WithAddress<TConfig>>;
}

export interface ArtifactProvider<
  TConfig,
  TAddressMap extends Record<string, unknown>,
> {
  availableTypes: () => (keyof TConfig)[];
  createReader: (provider: IProvider) => ArtifactReader<TConfig>;
  createModuleFactory: (
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ) => HypModuleFactory<TConfig, TAddressMap>;
}

export type ArtifactFactory<
  AT extends Record<string, ArtifactType>,
  K extends keyof AT,
> = [
  readerFactory: (reader: ProtocolReader) => ArtifactReaderPoc<AT[K]>,
  writerFactory: (writer: ProtocolWriter) => ArtifactWriter<AT[K]>,
];

export type ArtifactFactories<AT extends Record<string, ArtifactType>> = {
  [K in keyof AT]?: ArtifactFactory<AT, K>;
};

export interface ArtifactProviderPoc<AT extends Record<string, ArtifactType>> {
  availableTypes(): () => Set<keyof AT>;
  readable(
    reader: ProtocolReader,
  ): <K extends keyof AT>(type: K) => ArtifactReaderPoc<AT[K]>;
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
      const cache = new Map<keyof AT, ArtifactReaderPoc<AT[keyof AT]>>();
      return <T extends keyof AT>(type: T) => {
        if (!cache.has(type)) {
          const factory = factories[type];
          if (!factory) {
            throw new Error(`No factory registered for type ${String(type)}`);
          }
          const [readerFactory, _] = factory;
          cache.set(type, readerFactory(reader));
        }
        return cache.get(type)! as ArtifactReaderPoc<AT[T]>;
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
