/**
 * Pure compile-time type tests for ConfigOnChain and TransformNestedArtifacts
 * These tests don't require a test runner - they pass/fail at compile time
 */
import { Artifact, ArtifactOnChain, ConfigOnChain } from './artifact.js';

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
// Mixed nested object (limitation - not transformed)
// ============================================================================

interface MixedNestedConfig {
  mixed: {
    art: Artifact<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
}

type MixedNestedResult = ConfigOnChain<MixedNestedConfig>;

// Expected: the mixed object is NOT transformed (falls through to C[K])
type ExpectedMixedNested = {
  mixed: {
    art: Artifact<TestConfig, TestDeployed>;
    bar: string;
  };
  name: string;
};

export type _Test8 = AssertTrue<Equals<MixedNestedResult, ExpectedMixedNested>>;

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

export type _Test9 = AssertTrue<Equals<PrimitivesResult, ExpectedPrimitives>>;

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
export type _Test10 = AssertTrue<
  Equals<_StrictRequiredResult, _CorrectRequired>
>;
