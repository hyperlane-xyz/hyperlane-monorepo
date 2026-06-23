/**
 * Pure compile-time type tests for ConfigOnChain and TransformNestedArtifacts
 * These tests don't require a test runner - they pass/fail at compile time
 */
import {
  Artifact,
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactEmbedded,
  ArtifactNew,
  ArtifactOnChain,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
  ConfigOnChain,
  WithComposition,
  WithCompositionVariant,
  WithEmbeddedChildren,
} from './artifact.js';

// Type equality test utility
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

type AssertTrue<T extends true> = T;
export type AssertFalse<T extends false> = T;

// Test setup types
interface TestConfig {
  setting: string;
}

interface TestDeployed {
  address: string;
}

// ============================================================================
// Basic transformations
// ============================================================================

interface RequiredArtifactConfig {
  art: Artifact<TestConfig, TestDeployed>;
  bar: string;
}

type RequiredResult = ConfigOnChain<RequiredArtifactConfig>;

// Expected type:
type ExpectedRequired = {
  art: ArtifactOnChain<TestConfig, TestDeployed>;
  bar: string;
};

// This should pass: art should be required (not optional)
export type _Test1 = AssertTrue<Equals<RequiredResult, ExpectedRequired>>;

// ============================================================================
// Optional Artifact property
// ============================================================================

interface OptionalArtifactConfig {
  art?: Artifact<TestConfig, TestDeployed>;
  bar: string;
}

type OptionalResult = ConfigOnChain<OptionalArtifactConfig>;

type ExpectedOptional = {
  art?: ArtifactOnChain<TestConfig, TestDeployed>;
  bar: string;
};

export type _Test2 = AssertTrue<Equals<OptionalResult, ExpectedOptional>>;

// ============================================================================
// Array of Artifacts
// ============================================================================

interface ArrayConfig {
  artifacts: Artifact<TestConfig, TestDeployed>[];
  name: string;
}

type ArrayResult = ConfigOnChain<ArrayConfig>;

type ExpectedArray = {
  artifacts: ArtifactOnChain<TestConfig, TestDeployed>[];
  name: string;
};

export type _Test3 = AssertTrue<Equals<ArrayResult, ExpectedArray>>;

// ============================================================================
// Nested object with all required Artifacts
// ============================================================================

interface NestedRequiredConfig {
  domains: {
    domain1: Artifact<TestConfig, TestDeployed>;
    domain2: Artifact<TestConfig, TestDeployed>;
  };
  owner: string;
}

type NestedRequiredResult = ConfigOnChain<NestedRequiredConfig>;

type ExpectedNestedRequired = {
  domains: {
    domain1: ArtifactOnChain<TestConfig, TestDeployed>;
    domain2: ArtifactOnChain<TestConfig, TestDeployed>;
  };
  owner: string;
};

export type _Test4 = AssertTrue<
  Equals<NestedRequiredResult, ExpectedNestedRequired>
>;

// ============================================================================
// Nested object with all optional Artifacts
// ============================================================================

interface NestedOptionalConfig {
  fallbacks: {
    primary?: Artifact<TestConfig, TestDeployed>;
    secondary?: Artifact<TestConfig, TestDeployed>;
  };
  enabled: boolean;
}

type NestedOptionalResult = ConfigOnChain<NestedOptionalConfig>;

type ExpectedNestedOptional = {
  fallbacks: {
    primary?: ArtifactOnChain<TestConfig, TestDeployed>;
    secondary?: ArtifactOnChain<TestConfig, TestDeployed>;
  };
  enabled: boolean;
};

export type _Test5 = AssertTrue<
  Equals<NestedOptionalResult, ExpectedNestedOptional>
>;

// ============================================================================
// Record with required Artifacts
// ============================================================================

interface RecordConfig {
  type: 'routing';
  domains: Record<number, Artifact<TestConfig, TestDeployed>>;
  owner: string;
}

type RecordResult = ConfigOnChain<RecordConfig>;

type ExpectedRecord = {
  type: 'routing';
  domains: Record<number, ArtifactOnChain<TestConfig, TestDeployed>>;
  owner: string;
};

export type _Test6 = AssertTrue<Equals<RecordResult, ExpectedRecord>>;

// ============================================================================
// Record with optional Artifacts
// ============================================================================

interface RecordOptionalConfig {
  type: 'fallback';
  domains: Record<number, Artifact<TestConfig, TestDeployed> | undefined>;
  owner: string;
}

type RecordOptionalResult = ConfigOnChain<RecordOptionalConfig>;

type ExpectedRecordOptional = {
  type: 'fallback';
  domains: Record<
    number,
    ArtifactOnChain<TestConfig, TestDeployed> | undefined
  >;
  owner: string;
};

export type _Test7 = AssertTrue<
  Equals<RecordOptionalResult, ExpectedRecordOptional>
>;

// ============================================================================
// Mixed nested object (artifact properties transformed recursively)
// ============================================================================

interface MixedNestedConfig {
  mixed: {
    art: Artifact<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
}

type MixedNestedResult = ConfigOnChain<MixedNestedConfig>;

// Expected: the mixed object IS transformed recursively
type ExpectedMixedNested = {
  mixed: {
    art: ArtifactOnChain<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
};

export type _Test8 = AssertTrue<Equals<MixedNestedResult, ExpectedMixedNested>>;

// ============================================================================
// Optional mixed nested object
// ============================================================================

interface OptionalMixedNestedConfig {
  mixed?: {
    art: Artifact<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
}

type OptionalMixedNestedResult = ConfigOnChain<OptionalMixedNestedConfig>;

// Expected: the optional mixed object IS transformed recursively
type ExpectedOptionalMixedNested = {
  mixed?: {
    art: ArtifactOnChain<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
};

export type _Test9 = AssertTrue<
  Equals<OptionalMixedNestedResult, ExpectedOptionalMixedNested>
>;

// ============================================================================
// Mixed nested object with optional Artifact property inside
// ============================================================================

interface MixedNestedOptionalArtifactConfig {
  mixed: {
    art?: Artifact<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
}

type MixedNestedOptionalArtifactResult =
  ConfigOnChain<MixedNestedOptionalArtifactConfig>;

// Expected: the optional Artifact inside the nested object is transformed
type ExpectedMixedNestedOptionalArtifact = {
  mixed: {
    art?: ArtifactOnChain<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
};

export type _Test10 = AssertTrue<
  Equals<MixedNestedOptionalArtifactResult, ExpectedMixedNestedOptionalArtifact>
>;

// ============================================================================
// Primitives unchanged
// ============================================================================

interface PrimitivesConfig {
  str: string;
  num: number;
  bool: boolean;
  nullable: string | null;
  optional?: number;
}

type PrimitivesResult = ConfigOnChain<PrimitivesConfig>;

type ExpectedPrimitives = {
  str: string;
  num: number;
  bool: boolean;
  nullable: string | null;
  optional?: number;
};

export type _Test11 = AssertTrue<Equals<PrimitivesResult, ExpectedPrimitives>>;

// ============================================================================
// Test that required Artifact does NOT become optional
// ============================================================================

interface StrictRequiredConfig {
  required: Artifact<TestConfig, TestDeployed>;
}

type _StrictRequiredResult = ConfigOnChain<StrictRequiredConfig>;

// This type should have required 'required' field (not optional)
type _CorrectRequired = {
  required: ArtifactOnChain<TestConfig, TestDeployed>;
};

// This should now pass with the fixed implementation
export type _Test12 = AssertTrue<
  Equals<_StrictRequiredResult, _CorrectRequired>
>;

// ============================================================================
// EMBEDDED state — Artifact<> union widening
// ============================================================================

type _EmbeddedFromArtifact = Extract<
  Artifact<TestConfig, TestDeployed>,
  { artifactState: typeof ArtifactState.EMBEDDED }
>;
export type _Test13 = AssertTrue<
  Equals<_EmbeddedFromArtifact, ArtifactEmbedded<TestConfig>>
>;

// ArtifactOnChain<> must NOT include the EMBEDDED variant — it represents
// post-deploy state only.
type _EmbeddedFromOnChain = Extract<
  ArtifactOnChain<TestConfig, TestDeployed>,
  { artifactState: typeof ArtifactState.EMBEDDED }
>;
export type _Test14 = AssertTrue<Equals<_EmbeddedFromOnChain, never>>;

// ============================================================================
// WithEmbeddedChildren — required Artifact position
// ============================================================================

interface SingleEmbeddedConfig {
  art: Artifact<TestConfig, TestDeployed>;
  bar: string;
}

type SingleEmbeddedResult = WithEmbeddedChildren<SingleEmbeddedConfig>;

type ExpectedSingleEmbedded = {
  art: ArtifactEmbedded<TestConfig>;
  bar: string;
};

export type _Test15 = AssertTrue<
  Equals<SingleEmbeddedResult, ExpectedSingleEmbedded>
>;

// ============================================================================
// WithEmbeddedChildren — optional Artifact position
// ============================================================================

interface OptionalEmbeddedConfig {
  art?: Artifact<TestConfig, TestDeployed>;
  bar: string;
}

type OptionalEmbeddedResult = WithEmbeddedChildren<OptionalEmbeddedConfig>;

type ExpectedOptionalEmbedded = {
  art?: ArtifactEmbedded<TestConfig>;
  bar: string;
};

export type _Test16 = AssertTrue<
  Equals<OptionalEmbeddedResult, ExpectedOptionalEmbedded>
>;

// ============================================================================
// WithEmbeddedChildren — array Artifact position
// ============================================================================

interface ArrayEmbeddedConfig {
  artifacts: Artifact<TestConfig, TestDeployed>[];
  name: string;
}

type ArrayEmbeddedResult = WithEmbeddedChildren<ArrayEmbeddedConfig>;

type ExpectedArrayEmbedded = {
  artifacts: ArtifactEmbedded<TestConfig>[];
  name: string;
};

export type _Test17 = AssertTrue<
  Equals<ArrayEmbeddedResult, ExpectedArrayEmbedded>
>;

// ============================================================================
// WithEmbeddedChildren — Record<number, Artifact<...>> handled by fall-through
// ============================================================================

interface RecordEmbeddedConfig {
  type: 'routing';
  domains: Record<number, Artifact<TestConfig, TestDeployed>>;
  owner: string;
}

type RecordEmbeddedResult = WithEmbeddedChildren<RecordEmbeddedConfig>;

type ExpectedRecordEmbedded = {
  type: 'routing';
  domains: Record<number, ArtifactEmbedded<TestConfig>>;
  owner: string;
};

export type _Test18 = AssertTrue<
  Equals<RecordEmbeddedResult, ExpectedRecordEmbedded>
>;

// ============================================================================
// WithEmbeddedChildren — nested object literal with Artifact properties
// ============================================================================

interface NestedEmbeddedConfig {
  domains: {
    domain1: Artifact<TestConfig, TestDeployed>;
    domain2: Artifact<TestConfig, TestDeployed>;
  };
  owner: string;
}

type NestedEmbeddedResult = WithEmbeddedChildren<NestedEmbeddedConfig>;

type ExpectedNestedEmbedded = {
  domains: {
    domain1: ArtifactEmbedded<TestConfig>;
    domain2: ArtifactEmbedded<TestConfig>;
  };
  owner: string;
};

export type _Test19 = AssertTrue<
  Equals<NestedEmbeddedResult, ExpectedNestedEmbedded>
>;

// ============================================================================
// WithEmbeddedChildren — primitives and non-Artifact fields preserved
// ============================================================================

interface PrimitivesEmbeddedConfig {
  str: string;
  num: number;
  bool: boolean;
  nullable: string | null;
  optional?: number;
}

type PrimitivesEmbeddedResult = WithEmbeddedChildren<PrimitivesEmbeddedConfig>;

type ExpectedPrimitivesEmbedded = {
  str: string;
  num: number;
  bool: boolean;
  nullable: string | null;
  optional?: number;
};

export type _Test20 = AssertTrue<
  Equals<PrimitivesEmbeddedResult, ExpectedPrimitivesEmbedded>
>;

// ============================================================================
// WithComposition — both variants extractable
// ============================================================================

interface BaseCompositeConfig {
  art: Artifact<TestConfig, TestDeployed>;
  name: string;
}

type ComposedConfig = WithComposition<BaseCompositeConfig>;

type EmbeddedVariant = Extract<
  ComposedConfig,
  { composition: typeof ArtifactComposition.EMBEDDED }
>;
type OrchestratedVariant = Extract<
  ComposedConfig,
  { composition: typeof ArtifactComposition.ORCHESTRATED }
>;

type ExpectedEmbeddedVariant = WithEmbeddedChildren<BaseCompositeConfig> & {
  composition: typeof ArtifactComposition.EMBEDDED;
};
type ExpectedOrchestratedVariant = BaseCompositeConfig & {
  composition: typeof ArtifactComposition.ORCHESTRATED;
};

export type _Test21a = AssertTrue<
  Equals<EmbeddedVariant, ExpectedEmbeddedVariant>
>;
export type _Test21b = AssertTrue<
  Equals<OrchestratedVariant, ExpectedOrchestratedVariant>
>;

// ============================================================================
// ConfigOnChain — EMBEDDED children collapse to ArtifactDeployed<C, D>
// ============================================================================

interface EmbeddedChildConfig {
  child: ArtifactEmbedded<TestConfig>;
  optChild?: ArtifactEmbedded<TestConfig>;
  many: ArtifactEmbedded<TestConfig>[];
  name: string;
}

type EmbeddedChildResult = ConfigOnChain<EmbeddedChildConfig, TestDeployed>;

type ExpectedEmbeddedChild = {
  child: ArtifactDeployed<TestConfig, TestDeployed>;
  optChild?: ArtifactDeployed<TestConfig, TestDeployed>;
  many: ArtifactDeployed<TestConfig, TestDeployed>[];
  name: string;
};

export type _Test22 = AssertTrue<
  Equals<EmbeddedChildResult, ExpectedEmbeddedChild>
>;

// ============================================================================
// ArtifactWriter is the union of orchestrated + embedded variants
// ============================================================================

type ComposedWriter = ArtifactWriter<
  WithComposition<BaseCompositeConfig>,
  TestDeployed,
  ArtifactComposition
>;

type EmbeddedWriter = Extract<
  ComposedWriter,
  { composition: typeof ArtifactComposition.EMBEDDED }
>;
type OrchestratedWriter = Extract<
  ComposedWriter,
  { composition: typeof ArtifactComposition.ORCHESTRATED }
>;

// Each extracted variant must structurally match the matching interface and
// must narrow create()'s input via WithCompositionVariant — i.e. the embedded
// writer accepts ArtifactNew of the embedded-children variant, while the
// orchestrated writer accepts ArtifactNew of the plain-base variant.
export type _Test23a = AssertTrue<
  Equals<EmbeddedWriter['composition'], typeof ArtifactComposition.EMBEDDED>
>;
export type _Test23b = AssertTrue<
  Equals<
    OrchestratedWriter['composition'],
    typeof ArtifactComposition.ORCHESTRATED
  >
>;
export type _Test23c = AssertTrue<
  Equals<
    Parameters<EmbeddedWriter['create']>[0],
    ArtifactNew<
      WithEmbeddedChildren<BaseCompositeConfig> & {
        composition: typeof ArtifactComposition.EMBEDDED;
      }
    >
  >
>;
export type _Test23d = AssertTrue<
  Equals<
    Parameters<OrchestratedWriter['create']>[0],
    ArtifactNew<
      BaseCompositeConfig & {
        composition: typeof ArtifactComposition.ORCHESTRATED;
      }
    >
  >
>;

// The split union must structurally match the per-variant ArtifactWriter
// resolutions (orchestrated default + explicit embedded).
export type _Test23e = AssertTrue<
  Equals<
    EmbeddedWriter,
    ArtifactWriter<
      WithComposition<BaseCompositeConfig>,
      TestDeployed,
      typeof ArtifactComposition.EMBEDDED
    >
  >
>;
export type _Test23f = AssertTrue<
  Equals<
    OrchestratedWriter,
    ArtifactWriter<WithComposition<BaseCompositeConfig>, TestDeployed>
  >
>;

// ============================================================================
// WithCompositionVariant — identity on non-composite C
// ============================================================================

export type _TestNonCompositeUnchangedOrchestrated = AssertTrue<
  Equals<
    WithCompositionVariant<TestConfig, typeof ArtifactComposition.ORCHESTRATED>,
    TestConfig
  >
>;
export type _TestNonCompositeUnchangedEmbedded = AssertTrue<
  Equals<
    WithCompositionVariant<TestConfig, typeof ArtifactComposition.EMBEDDED>,
    TestConfig
  >
>;

// ============================================================================
// Non-composite C: reader union still narrowable on `composition`
// ============================================================================

type PlainReader = ArtifactReader<RequiredArtifactConfig, TestDeployed>;

type PlainOrchestratedReader = Extract<
  PlainReader,
  { composition: typeof ArtifactComposition.ORCHESTRATED }
>;

export type _Test24 = AssertTrue<
  Equals<
    PlainOrchestratedReader['composition'],
    typeof ArtifactComposition.ORCHESTRATED
  >
>;

// ============================================================================
// Writer create input/output split: bare pre-deploy in, ConfigOnChain out
//
// For composite C (WithComposition), create's input has children in the
// pre-deploy shape (Artifact<> for ORCHESTRATED, ArtifactEmbedded<> for
// EMBEDDED), and create's output collapses children to ArtifactOnChain<> /
// ArtifactDeployed<> via ConfigOnChain. The two are intentionally different
// shapes — writers consume the input as-given and produce the post-deploy
// shape independently.
// ============================================================================

type EmbeddedWriterCreateInput = Parameters<EmbeddedWriter['create']>[0];
type EmbeddedWriterCreateOutput = Awaited<
  ReturnType<EmbeddedWriter['create']>
>[0];

// Embedded create input: children are ArtifactEmbedded
export type _Test25a = AssertTrue<
  Equals<
    EmbeddedWriterCreateInput,
    ArtifactNew<
      WithEmbeddedChildren<BaseCompositeConfig> & {
        composition: typeof ArtifactComposition.EMBEDDED;
      }
    >
  >
>;

// Embedded create output: children collapse to ArtifactDeployed via ConfigOnChain
export type _Test25b = AssertTrue<
  Equals<
    EmbeddedWriterCreateOutput,
    ArtifactDeployed<
      ConfigOnChain<
        WithEmbeddedChildren<BaseCompositeConfig> & {
          composition: typeof ArtifactComposition.EMBEDDED;
        },
        TestDeployed
      >,
      TestDeployed
    >
  >
>;

type OrchestratedWriterCreateInput = Parameters<
  OrchestratedWriter['create']
>[0];
type OrchestratedWriterCreateOutput = Awaited<
  ReturnType<OrchestratedWriter['create']>
>[0];

// Orchestrated create input: children stay in Artifact<> union (pre-deploy)
export type _Test25c = AssertTrue<
  Equals<
    OrchestratedWriterCreateInput,
    ArtifactNew<
      BaseCompositeConfig & {
        composition: typeof ArtifactComposition.ORCHESTRATED;
      }
    >
  >
>;

// Orchestrated create output: children collapse to ArtifactOnChain via ConfigOnChain
export type _Test25d = AssertTrue<
  Equals<
    OrchestratedWriterCreateOutput,
    ArtifactDeployed<
      ConfigOnChain<
        BaseCompositeConfig & {
          composition: typeof ArtifactComposition.ORCHESTRATED;
        },
        TestDeployed
      >,
      TestDeployed
    >
  >
>;
