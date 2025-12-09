import { ISigner } from './altvm.js';
import { AnnotatedTx, TxReceipt } from './module.js';

export const ArtifactState = {
  NEW: 'new',
  DEPLOYED: 'deployed',
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
export type RawArtifact<T> =
  T extends Artifact<any, any>
    ? string
    : T extends Record<infer K, Artifact<any, any>>
      ? Record<K, string>
      : T extends Array<Artifact<any, any>>
        ? Array<string>
        : T extends Record<string, any>
          ? { [K in keyof T]: RawArtifact<T[K]> }
          : T;

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
    accountAddress: string,
  ): ArtifactWriter<ConfigMap[T], D>;
}
