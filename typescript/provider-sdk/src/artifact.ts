import {
  assert,
  isEmptyAddress,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';
import { ISigner } from './altvm.js';
import { AnnotatedTx, TxReceipt } from './module.js';

export const ArtifactState = {
  NEW: 'new',
  DEPLOYED: 'deployed',
  UNDERIVED: 'underived',
  EMBEDDED: 'embedded',
} as const;

export type ArtifactState = (typeof ArtifactState)[keyof typeof ArtifactState];

export const ArtifactComposition = {
  EMBEDDED: 'embedded',
  ORCHESTRATED: 'orchestrated',
} as const;

export type ArtifactComposition =
  (typeof ArtifactComposition)[keyof typeof ArtifactComposition];

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
 * Represents a pre-deploy artifact whose lifecycle is owned by a parent
 * composite artifact rather than its own writer. Used when a single program
 * holds multiple "children" inside its address space (e.g. SVM multisig PDAs).
 *
 * No `deployed` field — embedded artifacts only exist pre-create; after the
 * parent's create() they appear as ArtifactDeployed in the post-read transform.
 */
export type ArtifactEmbedded<C> = {
  artifactState: typeof ArtifactState.EMBEDDED;
  config: C;
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
  | ArtifactUnderived<D>
  | ArtifactEmbedded<C>;

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
 * Type guard to check if an artifact is in the EMBEDDED state.
 */
export function isArtifactEmbedded<C, D>(
  artifact: Artifact<C, D>,
): artifact is ArtifactEmbedded<C> {
  return artifact.artifactState === ArtifactState.EMBEDDED;
}

/**
 * Narrows C to its `{ composition: M }` variant when C is a WithComposition
 * union; passes C through unchanged when C has no `composition` discriminant
 * (non-composite types).
 */
export type WithCompositionVariant<
  C,
  M extends ArtifactComposition,
> = C extends { composition: ArtifactComposition }
  ? Extract<C, { composition: M }>
  : C;

/**
 * Reader for the orchestrated composition variant. Children are independently
 * deployed; the artifact's address resolves to the parent contract/program only.
 *
 * `read()` returns the post-deploy on-chain shape: children are
 * `ArtifactOnChain` (DEPLOYED | UNDERIVED), with EMBEDDED children — if any —
 * collapsed to `ArtifactDeployed` via `ConfigOnChain`.
 */
export interface OrchestratedArtifactReader<C, D> {
  readonly composition: typeof ArtifactComposition.ORCHESTRATED;
  read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      ConfigOnChain<
        WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
        D
      >,
      D
    >
  >;
}

/**
 * Writer for the orchestrated composition variant.
 *
 * `create()` accepts the bare pre-deploy config — children remain in their
 * `Artifact<>` union shape — and returns the post-deploy on-chain shape.
 * `update()` accepts the post-deploy on-chain shape; child reconciliation is
 * the writer's responsibility (most writers enumerate live state directly).
 */
export interface OrchestratedArtifactWriter<
  C,
  D,
> extends OrchestratedArtifactReader<C, D> {
  create(
    artifact: ArtifactNew<
      WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>
    >,
  ): Promise<
    [
      ArtifactDeployed<
        ConfigOnChain<
          WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
          D
        >,
        D
      >,
      TxReceipt[],
    ]
  >;
  update(
    artifact: ArtifactDeployed<
      WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
      D
    >,
  ): Promise<AnnotatedTx[]>;
}

/**
 * Reader for the embedded composition variant. Children live inside the
 * parent's address space (e.g. SVM PDAs); the parent's read returns the full
 * subtree.
 *
 * `read()` returns the post-deploy on-chain shape with embedded children
 * collapsed to `ArtifactDeployed` via `ConfigOnChain`.
 */
export interface EmbeddedArtifactReader<C, D> {
  readonly composition: typeof ArtifactComposition.EMBEDDED;
  read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      ConfigOnChain<
        WithCompositionVariant<C, typeof ArtifactComposition.EMBEDDED>,
        D
      >,
      D
    >
  >;
}

/**
 * Writer for the embedded composition variant.
 *
 * `create()` accepts the bare pre-deploy config (children are `ArtifactEmbedded`)
 * and returns the post-deploy on-chain shape with children collapsed to
 * `ArtifactDeployed`. `update()` accepts the bare pre-deploy config too —
 * runtime writers enumerate live on-chain children directly rather than
 * relying on the input.
 */
export interface EmbeddedArtifactWriter<C, D> extends EmbeddedArtifactReader<
  C,
  D
> {
  create(
    artifact: ArtifactNew<
      WithCompositionVariant<C, typeof ArtifactComposition.EMBEDDED>
    >,
  ): Promise<
    [
      ArtifactDeployed<
        ConfigOnChain<
          WithCompositionVariant<C, typeof ArtifactComposition.EMBEDDED>,
          D
        >,
        D
      >,
      TxReceipt[],
    ]
  >;
  update(
    artifact: ArtifactDeployed<
      WithCompositionVariant<C, typeof ArtifactComposition.EMBEDDED>,
      D
    >,
  ): Promise<AnnotatedTx[]>;
}

/**
 * Public reader union. Narrowing on `reader.composition` resolves to one
 * variant (orchestrated or embedded). Implementations pick one of the two
 * specific interfaces above.
 */
export type ArtifactReader<C, D> =
  | OrchestratedArtifactReader<C, D>
  | EmbeddedArtifactReader<C, D>;

/**
 * Public writer union. Narrowing on `writer.composition` resolves to one
 * variant (orchestrated or embedded). Implementations pick one of the two
 * specific interfaces above.
 */
export type ArtifactWriter<C, D> =
  | OrchestratedArtifactWriter<C, D>
  | EmbeddedArtifactWriter<C, D>;

/**
 * Helper type to transform nested objects containing Artifacts.
 * Handles objects where all properties are Artifacts (required or optional)
 * and ArtifactEmbedded children (which collapse to ArtifactDeployed in the
 * post-create read shape).
 */
type NestedOnChain<T, D = unknown> =
  T extends Record<string, unknown>
    ? {
        [L in keyof T]: T[L] extends ArtifactEmbedded<infer CC>
          ? ArtifactDeployed<CC, D>
          : T[L] extends ArtifactEmbedded<infer CC> | undefined
            ? ArtifactDeployed<CC, D> | undefined
            : T[L] extends Artifact<infer CC, infer DD>
              ? ArtifactOnChain<CC, DD>
              : T[L] extends Artifact<infer CC, infer DD> | undefined
                ? ArtifactOnChain<CC, DD> | undefined
                : T[L];
      }
    : T;

/**
 * Utility type to convert a config type to its on-chain representation.
 * Replaces Artifact<> types one level deep with ArtifactOnChain<> types.
 * ArtifactEmbedded<> children collapse to ArtifactDeployed<C, D> — after the
 * parent's create() they always exist on-chain alongside the parent.
 * Handles optional/undefined fields properly using conditional modifiers.
 */
export type ConfigOnChain<C, D = unknown> = {
  [K in keyof C]: C[K] extends ArtifactEmbedded<infer CC>
    ? ArtifactDeployed<CC, D>
    : C[K] extends ArtifactEmbedded<infer CC> | undefined
      ? ArtifactDeployed<CC, D> | undefined
      : C[K] extends ArtifactEmbedded<infer CC>[]
        ? ArtifactDeployed<CC, D>[]
        : C[K] extends Artifact<infer CC, infer DD>
          ? ArtifactOnChain<CC, DD>
          : C[K] extends Artifact<infer CC, infer DD> | undefined
            ? ArtifactOnChain<CC, DD> | undefined
            : C[K] extends Artifact<infer CC, infer DD>[]
              ? ArtifactOnChain<CC, DD>[]
              : NestedOnChain<C[K], D>;
};

/**
 * Helper type to transform nested objects whose properties are Artifacts
 * into the embedded-children shape.
 */
type NestedEmbedded<T> =
  T extends Record<string, unknown>
    ? {
        [L in keyof T]: T[L] extends Artifact<infer CC, infer _DD>
          ? ArtifactEmbedded<CC>
          : T[L] extends Artifact<infer CC, infer _DD> | undefined
            ? ArtifactEmbedded<CC> | undefined
            : T[L];
      }
    : T;

/**
 * Replaces every Artifact<CC, DD> position in C with ArtifactEmbedded<CC>.
 * Used to express the "embedded" variant of a composite type whose children
 * live inside the parent's address space rather than being separately deployed.
 *
 * Mirrors the clause structure of ConfigOnChain: single, optional, array,
 * with Records and nested object literals handled by NestedEmbedded fall-through.
 */
export type WithEmbeddedChildren<C> = {
  [K in keyof C]: C[K] extends Artifact<infer CC, infer _DD>
    ? ArtifactEmbedded<CC>
    : C[K] extends Artifact<infer CC, infer _DD> | undefined
      ? ArtifactEmbedded<CC> | undefined
      : C[K] extends Artifact<infer CC, infer _DD>[]
        ? ArtifactEmbedded<CC>[]
        : NestedEmbedded<C[K]>;
};

/**
 * Lifts a composite-artifact config Base into a 2-variant discriminated union
 * keyed by `composition`:
 * - `'embedded'`     — children live inside the parent's address space; uses
 *                      ArtifactEmbedded<> at each child position.
 * - `'orchestrated'` — children are independently deployed; uses Artifact<>
 *                      at each child position (the existing shape).
 *
 * Protocol writers / readers narrow on `composition` to dispatch.
 */
export type WithComposition<Base> =
  | (WithEmbeddedChildren<Base> & {
      composition: typeof ArtifactComposition.EMBEDDED;
    })
  | (Base & { composition: typeof ArtifactComposition.ORCHESTRATED });

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
  ConfigMap extends Record<TypeKey, unknown>,
  D,
> {
  createReader<T extends TypeKey>(type: T): ArtifactReader<ConfigMap[T], D>;

  createWriter<T extends TypeKey>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<ConfigMap[T], D>;
}

export type UnsetArtifactAddress = typeof ZERO_ADDRESS_HEX_32;

/**
 * Returns the artifact if DEPLOYED, undefined if UNDERIVED with zero address.
 * Throws if UNDERIVED with non-zero address.
 */
export function toDeployedOrUndefined<C, D extends { address: string }>(
  artifact: ArtifactOnChain<C, D>,
  name: string,
): ArtifactDeployed<C, D> | undefined {
  if (isArtifactDeployed(artifact)) return artifact;
  assert(
    isEmptyAddress(artifact.deployed.address),
    `Expected ${name} to be DEPLOYED or UNDERIVED with zero address, got UNDERIVED with non-zero address ${artifact.deployed.address}`,
  );
  return undefined;
}

export function addressToUnderivedArtifact(
  address: string | undefined,
  formatter?: (value: string) => string,
): ArtifactUnderived<{ address: string }> | undefined {
  if (!address || isEmptyAddress(address)) return undefined;

  return {
    artifactState: ArtifactState.UNDERIVED,
    deployed: {
      address: formatter ? formatter(address) : address,
    },
  };
}

export function artifactOnChainToAddress<C>(
  artifact: ArtifactOnChain<C, { address: string }> | undefined,
  formatter?: (value: string) => string,
): string | undefined {
  const address = artifact?.deployed.address;
  if (!address || isEmptyAddress(address)) return undefined;
  return formatter ? formatter(address) : address;
}
