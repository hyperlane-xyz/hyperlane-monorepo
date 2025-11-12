type AddrMap = Record<string, unknown>;
export type AnnotatedTx = { annotation?: string; [key: string]: any };
export type TxReceipt = { [key: string]: any };

export interface HypModuleArgs<Cfg, Addrs extends AddrMap> {
  addresses: Addrs;
  chain: string | number;
  config: string | Cfg;
}

export interface HypModule<Cfg, Addrs extends AddrMap> {
  read(): Promise<Cfg>;
  serialize(): Addrs;
  update(config: Cfg): Promise<AnnotatedTx[]>;
}

export interface HypModuleFactory<Cfg, Addrs extends AddrMap> {
  connect(args: HypModuleArgs<Cfg, Addrs>): HypModule<Cfg, Addrs>;
  create(config: Cfg): Promise<HypModule<Cfg, Addrs>>;
}

/* --------------------------------------------------------------- */

export interface ArtifactType {
  config: unknown;
  derived: unknown;
}

export type Config<T extends { config: unknown }> = T['config'];
export type Derived<T extends { derived: unknown }> = T['derived'];

export interface Transaction<T = unknown> {
  type: string;
  data: T;
}

export interface Receipt<T = unknown> {
  hash: string;
  status: string;
  data: T;
}

export interface ArtifactReaderPoc<T extends ArtifactType> {
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
