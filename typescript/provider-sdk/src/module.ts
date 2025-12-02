import { IProvider, ISigner } from './altvm.js';

type AddrMap = Record<string, unknown>;
export type AnnotatedTx = { annotation?: string; [key: string]: any };
export type TxReceipt = { [key: string]: any };

export interface ModuleType {
  config: unknown;
  derived: unknown;
  addresses: AddrMap;
}

/**
 * Helper type to extract a concrete ModuleType from config type.
 */
export type ExtractModuleType<
  TModule extends {
    config: { type: string };
    derived: { type: string };
    addresses: AddrMap;
  },
  TType extends TModule['config']['type'],
> = {
  config: Extract<TModule['config'], { type: TType }>;
  derived: Extract<TModule['derived'], { type: TType }>;
  addresses: TModule['addresses'];
};

export type Config<M extends ModuleType> = M['config'];
export type Derived<M extends ModuleType> = M['derived'];
export type Addresses<M extends ModuleType> = M['addresses'];

export interface HypModuleArgs<M extends ModuleType> {
  addresses: Addresses<M>;
  chain: string | number;
  config: string | Config<M>;
}

export interface HypReader<M extends ModuleType> {
  read(address: string): Promise<Derived<M>>;
}

export interface HypModule<M extends ModuleType> {
  read(): Promise<Derived<M>>;
  serialize(): Addresses<M>;
  update(config: Config<M>): Promise<AnnotatedTx[]>;
}

/**
 * Provides read-only access to artifacts modules on-chain.
 */
export interface ReaderProvider<M extends ModuleType> {
  /**
   * @param provider - Chain provider for making RPC calls
   * @returns A reader instance that can query module state
   */
  connectReader: (provider: IProvider) => HypReader<M>;
}

export interface ModuleProvider<M extends ModuleType>
  extends ReaderProvider<M> {
  connectModule: (
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<M>,
  ) => HypModule<M>;
  createModule: (
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: Config<M>,
  ) => Promise<HypModule<M>>;
}
