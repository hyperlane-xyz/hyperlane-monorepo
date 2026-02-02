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
export type ArtifactUnderived<D> = {
  artifactState: typeof ArtifactState.UNDERIVED;
  deployed: D;
};

/**
 * Union type representing a deployed artifact. Can be either the full artifact config
 * or its address on chain.
 */
export type ArtifactOnChain<C, D> =
  | ArtifactDeployed<C, D>
  | ArtifactUnderived<D>;

/**
 * Union type representing an artifact in any state.
 * Useful for APIs that can accept either new or deployed artifacts.
 */
export type Artifact<C, D = unknown> =
  | ArtifactNew<C>
  | ArtifactDeployed<C, D>
  | ArtifactUnderived<D>;

/**
 * Type guard to check if an artifact is in the NEW state.
 * Returns true when artifactState is undefined (the default) or explicitly NEW.
 */
export function isArtifactNew<C, D>(
  artifact: Artifact<C, D>,
): artifact is ArtifactNew<C> {
  return (
    artifact.artifactState === undefined ||
    artifact.artifactState === ArtifactState.NEW
  );
}

/**
 * Type guard to check if an artifact is in the DEPLOYED state.
 */
export function isArtifactDeployed<C, D>(
  artifact: Artifact<C, D>,
): artifact is ArtifactDeployed<C, D> {
  return artifact.artifactState === ArtifactState.DEPLOYED;
}

/**
 * Type guard to check if an artifact is in the UNDERIVED state.
 */
export function isArtifactUnderived<C, D>(
  artifact: Artifact<C, D>,
): artifact is ArtifactUnderived<D> {
  return artifact.artifactState === ArtifactState.UNDERIVED;
}

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
 * Utility type that converts Artifact<> references to ArtifactOnChain<> in a config type.
 * Used to create "raw" config types that protocol implementations work with.
 *
 * Transformations (non-recursive, single level only):
 * - Artifact<C, D> → ArtifactOnChain<C, D>
 * - Record<K, Artifact<C, D>> → Record<K, ArtifactOnChain<C, D>>
 * - Array<Artifact<C, D>> → Array<ArtifactOnChain<C, D>>
 * - Other properties remain unchanged
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
 * type RawRoutingIsmConfig = RawArtifact<RoutingIsmConfig, IsmDeployed>;
 * // Results in:
 * // {
 * //   type: 'routing';
 * //   owner: string;
 * //   domains: Record<number, ArtifactOnChain<IsmConfig, IsmDeployed>>;
 * // }
 * ```
 *
 * @deprecated FIXME: remove usage of this type in a follow up PR for the hook and ISM artifacts
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
 * Utility type to convert a config type to its on-chain representation.
 * Replaces Artifact<> types one level deep with ArtifactOnChain<> types.
 * Unlike RawArtifact, preserves the nested deployment types.
 * Handles optional/undefined fields properly.
 */
export type ConfigOnChain<C> = {
  [K in keyof C]: C[K] extends Artifact<infer CC, infer DD> | undefined
    ? ArtifactOnChain<CC, DD> | undefined
    : C[K] extends Artifact<infer CC, infer DD>
      ? ArtifactOnChain<CC, DD>
      : C[K] extends (Artifact<infer CC, infer DD> | undefined)[]
        ? (ArtifactOnChain<CC, DD> | undefined)[]
        : C[K] extends Artifact<infer CC, infer DD>[]
          ? ArtifactOnChain<CC, DD>[]
          : C[K] extends {
                [L: string]: Artifact<infer CC, infer DD> | undefined;
              }
            ? { [L in keyof C[K]]: ArtifactOnChain<CC, DD> | undefined }
            : C[K] extends { [L: string]: Artifact<infer CC, infer DD> }
              ? { [L in keyof C[K]]: ArtifactOnChain<CC, DD> }
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
