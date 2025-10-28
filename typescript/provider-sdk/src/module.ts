type AddrMap = Record<string, unknown>;
export type AnnotatedTx = { annotation?: string; [key: string]: any };

export interface HypModuleArgs<Cfg, Addrs extends AddrMap> {
  addresses: Addrs;
  chain: string | number;
  config: Cfg;
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
