import { IProvider, ISigner } from './altvm.js';

type AddrMap = Record<string, unknown>;
export type AnnotatedTx = { annotation?: string; [key: string]: any };
export type TxReceipt = { [key: string]: any };

export interface ModuleType {
  config: unknown;
  derived: unknown;
  addresses: AddrMap;
}

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

export interface ModuleProvider<M extends ModuleType> {
  connectReader: (provider: IProvider) => HypReader<M>;
  connectModule: (
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<M>,
  ) => HypModule<M>;
  createModule: (
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: Config<M>,
  ) => Promise<HypModule<M>>;
}

// == Artifact API ==

export type Artifact<C> = ArtifactNew<C> | ArtifactDeployed<C, unknown>;

export type ArtifactNew<C> = {
  artifactState?: 'new';
  config: C;
};

export type ArtifactDeployed<C, D> = {
  artifactState: 'deployed';
  config: C;
  deployed: D;
};

export type RawArtifact<C, D> = {
  [K in keyof C]: C[K] extends Artifact<infer CC>
    ? ArtifactDeployed<CC, D>
    : C[K] extends Artifact<infer CC>[]
      ? ArtifactDeployed<CC, D>[]
      : C[K] extends { [L: string]: Artifact<infer CC> }
        ? { [L in keyof C[K]]: ArtifactDeployed<CC, D> }
        : C[K];
};

export interface ArtifactReader<C, D> {
  read(address: string): Promise<ArtifactDeployed<C, D>>;
}
export interface ArtifactWriter<C, D> {
  create(config: Artifact<C>): Promise<[ArtifactDeployed<C, D>, TxReceipt[]]>;
  update(
    address: string,
    config: ArtifactDeployed<C, D>,
  ): Promise<AnnotatedTx[]>;
}
