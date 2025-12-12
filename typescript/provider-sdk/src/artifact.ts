import { ISigner } from './altvm.js';
import { AnnotatedTx, TxReceipt } from './module.js';

export const ArtifactState = {
  NEW: 'new',
  DEPLOYED: 'deployed',
  UNDERIVED: 'underived',
} as const;

export type ArtifactState = (typeof ArtifactState)[keyof typeof ArtifactState];

/**
 * Represents an artifact that has not yet been deployed.
 * Contains only the desired configuration.
 */
export type ArtifactNew<C> = {
  artifactState?: typeof ArtifactState.NEW;
  config: C;
};

/**
 * Represents an artifact that has been deployed on-chain.
 * Contains both the configuration and deployment-derived data (addresses, etc.).
 */
export type ArtifactDeployed<C, D> = {
  artifactState: typeof ArtifactState.DEPLOYED;
  config: C;
  deployed: D;
};

/**
 * Represents an artifact that has been deployed on chain
 * but is represented only by its address
 */
export type ArtifactUnderived = {
  artifactState: typeof ArtifactState.UNDERIVED;
  artifactAddress: string;
};

/**
 * Union type representing a deployed artifact. Can be either the full artifact config
 * or its address on chain.
 */
export type ArtifactOnChain<C, D> = ArtifactDeployed<C, D> | ArtifactUnderived;

/**
 * Union type representing an artifact in any state.
 * Useful for APIs that can accept either new or deployed artifacts.
 */
export type Artifact<C, D = unknown> = ArtifactNew<C> | ArtifactDeployed<C, D>;

/**
 * Interface for reading artifact state from the blockchain.
 */
export interface ArtifactReader<C, D> {
  /**
   * Read the current state of an artifact at the given address.
   * @param address The on-chain address of the artifact
   * @returns The artifact configuration and deployment data
   */
  read(address: string): Promise<ArtifactDeployed<C, D>>;
}

/**
 * Interface for creating and updating artifacts on the blockchain.
 */
export interface ArtifactWriter<C, D> extends ArtifactReader<C, D> {
  /**
   * Deploy a new artifact on-chain.
   * @param artifact The artifact configuration to deploy
   * @returns A tuple of [deployed artifact, transaction receipts]
   */
  create(
    artifact: ArtifactNew<C>,
  ): Promise<[ArtifactDeployed<C, D>, TxReceipt[]]>;

  /**
   * Update an existing artifact to match the desired configuration.
   * @param artifact The desired artifact state (must be deployed)
   * @returns Array of transactions needed to perform the update
   */
  update(artifact: ArtifactDeployed<C, D>): Promise<AnnotatedTx[]>;
}

/**
 * Utility type that transforms nested Artifact types to simple addresses.
 * Used to create "raw" config types that protocol implementations work with.
 *
 * Transformations:
 * - Artifact<SomeConfig, SomeDeployed> → string (address)
 * - Record<K, Artifact<C, D>> → Record<K, string>
 * - Array<Artifact<C, D>> → Array<string>
 * - Recursively transforms nested objects
 *
 * This enables defining compound configs once and deriving raw configs automatically.
 *
 * Example:
 * ```typescript
 * interface RoutingIsmConfig {
 *   type: 'routing';
 *   owner: string;
 *   domains: Record<number, Artifact<IsmConfig, IsmDeployed>>;
 * }
 *
 * type RawRoutingIsmConfig = RawArtifact<RoutingIsmConfig>;
 * // Results in:
 * // {
 * //   type: 'routing';
 * //   owner: string;
 * //   domains: Record<number, string>;
 * // }
 * ```
 */
export type RawArtifact<C, D> = {
  [K in keyof C]: C[K] extends Artifact<infer CC>
    ? ArtifactOnChain<CC, D>
    : C[K] extends Artifact<infer CC>[]
      ? ArtifactOnChain<CC, D>[]
      : C[K] extends { [L: string]: Artifact<infer CC> }
        ? { [L in keyof C[K]]: ArtifactOnChain<CC, D> }
        : C[K];
};

/**
 * Artifact Manager Interface
 *
 * Generic interface for managing artifact operations across different artifact types.
 * Can be specialized for ISMs, Hooks, Warp Routes, etc.
 *
 * Uses mapped types to enable proper type inference - when you call createReader(type),
 * TypeScript will infer the specific config type based on the type parameter.
 */
export interface IArtifactManager<
  TypeKey extends string,
  ConfigMap extends Record<TypeKey, any>,
  D,
> {
  createReader<T extends TypeKey>(type: T): ArtifactReader<ConfigMap[T], D>;

  createWriter<T extends TypeKey>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<ConfigMap[T], D>;
}
