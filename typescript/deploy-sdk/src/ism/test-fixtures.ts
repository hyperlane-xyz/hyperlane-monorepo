/**
 * Shared test fixtures for ISM writer tests.
 * Provides common constants, configs, and mock factories.
 */
import Sinon from 'sinon';

import { AltVM, MockSigner, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  DeployedRawIsmArtifact,
  IRawIsmArtifactManager,
  MultisigIsmConfig,
  RawIsmArtifactConfig,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

// ============================================================================
// Test Addresses
// ============================================================================

export const TEST_ADDRESSES = {
  EXISTING_ISM: '0xExistingIsm',
  NEW_ISM: '0xNewIsm',
  ROUTING_ISM: '0xRoutingIsm',
  DOMAIN1_ISM: '0xDomain1Ism',
  DOMAIN2_ISM: '0xDomain2Ism',
} as const;

// ============================================================================
// Test Configs
// ============================================================================

export const TEST_CONFIGS = {
  multisig: {
    base: {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator1'],
      threshold: 1,
    } satisfies MultisigIsmConfig,

    changed: {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator1', '0xValidator2'],
      threshold: 2,
    } satisfies MultisigIsmConfig,

    domain1: {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator1'],
      threshold: 1,
    } satisfies MultisigIsmConfig,

    domain2: {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator2'],
      threshold: 1,
    } satisfies MultisigIsmConfig,

    domain2Changed: {
      type: 'messageIdMultisigIsm',
      validators: ['0xValidator2', '0xValidator3'],
      threshold: 2,
    } satisfies MultisigIsmConfig,
  },

  routing: {
    empty: {
      type: 'domainRoutingIsm' as const,
      owner: '0xOwner',
      domains: {},
    },
  },
} as const;

// ============================================================================
// Mock Chain Lookup
// ============================================================================

export function createMockChainLookup(): ChainLookup {
  return {
    getChainMetadata: () => ({
      name: 'test',
      domainId: 1,
      chainId: 1,
      protocol: ProtocolType.Cosmos,
    }),
    getChainName: (domainId: number) =>
      domainId === 1 ? 'test' : domainId === 2 ? 'test2' : null,
    getDomainId: (chain: string | number) => {
      if (typeof chain === 'number') return chain;
      return chain === 'test' ? 1 : chain === 'test2' ? 2 : null;
    },
    getKnownChainNames: () => ['test', 'test2'],
  };
}

// ============================================================================
// Mock Artifact Factories
// ============================================================================

export function createDeployedArtifact<T>(
  config: T,
  address: string,
): DeployedIsmArtifact {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config,
    deployed: { address },
  } as DeployedIsmArtifact;
}

// ============================================================================
// Base Test Fixture
// ============================================================================

export interface BaseTestFixture {
  signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  chainLookup: ChainLookup;
}

export async function createBaseFixture(): Promise<BaseTestFixture> {
  return {
    signer: await MockSigner.connectWithSigner(),
    chainLookup: createMockChainLookup(),
  };
}

// ============================================================================
// IsmWriter Test Fixture
// ============================================================================

export interface IsmWriterTestFixture extends BaseTestFixture {
  mockArtifactManager: IRawIsmArtifactManager;
  multisigCreateSpy: Sinon.SinonStub;
  multisigUpdateSpy: Sinon.SinonStub;
  routingCreateSpy: Sinon.SinonStub;
  routingUpdateSpy: Sinon.SinonStub;
}

/**
 * Creates a test fixture for IsmWriter tests.
 * Default current ISM is a multisig - use mockArtifactManager.readIsm stub to change.
 */
export async function createIsmWriterTestFixture(): Promise<IsmWriterTestFixture> {
  const base = await createBaseFixture();

  // Create mock multisig writer (immutable ISM type)
  const multisigCreateSpy = Sinon.stub().resolves([
    createDeployedArtifact(
      TEST_CONFIGS.multisig.changed,
      TEST_ADDRESSES.NEW_ISM,
    ),
    [] as TxReceipt[],
  ]);
  const multisigUpdateSpy = Sinon.stub().resolves([] as AnnotatedTx[]);

  const mockMultisigWriter: ArtifactWriter<
    MultisigIsmConfig,
    DeployedIsmAddress
  > = {
    create: multisigCreateSpy,
    update: multisigUpdateSpy,
    read: Sinon.stub().resolves(
      createDeployedArtifact(
        TEST_CONFIGS.multisig.base,
        TEST_ADDRESSES.EXISTING_ISM,
      ),
    ),
  };

  // Create mock routing writer (mutable ISM type)
  const routingCreateSpy = Sinon.stub().resolves([
    createDeployedArtifact(TEST_CONFIGS.routing.empty, TEST_ADDRESSES.NEW_ISM),
    [] as TxReceipt[],
  ]);
  const routingUpdateSpy = Sinon.stub().resolves([
    { annotation: 'mock routing update tx' } as AnnotatedTx,
  ]);

  const mockRoutingWriter: ArtifactWriter<
    RawRoutingIsmArtifactConfig,
    DeployedIsmAddress
  > = {
    create: routingCreateSpy,
    update: routingUpdateSpy,
    read: Sinon.stub().resolves(
      createDeployedArtifact(
        TEST_CONFIGS.routing.empty,
        TEST_ADDRESSES.EXISTING_ISM,
      ),
    ),
  };

  // Create mock artifact manager - default returns multisig ISM
  const mockArtifactManager: IRawIsmArtifactManager = {
    readIsm: Sinon.stub().resolves(
      createDeployedArtifact(
        TEST_CONFIGS.multisig.base,
        TEST_ADDRESSES.EXISTING_ISM,
      ),
    ),

    createReader: ((type: string) => {
      if (type === AltVM.IsmType.ROUTING) {
        return mockRoutingWriter as ArtifactReader<
          RawIsmArtifactConfig,
          DeployedIsmAddress
        >;
      }
      return mockMultisigWriter as ArtifactReader<
        RawIsmArtifactConfig,
        DeployedIsmAddress
      >;
    }) as IRawIsmArtifactManager['createReader'],

    createWriter: ((type: string, _signer: unknown) => {
      if (type === AltVM.IsmType.ROUTING) {
        return mockRoutingWriter as ArtifactWriter<
          RawIsmArtifactConfig,
          DeployedIsmAddress
        >;
      }
      return mockMultisigWriter as ArtifactWriter<
        RawIsmArtifactConfig,
        DeployedIsmAddress
      >;
    }) as IRawIsmArtifactManager['createWriter'],
  } satisfies Partial<IRawIsmArtifactManager> as IRawIsmArtifactManager;

  return {
    ...base,
    mockArtifactManager,
    multisigCreateSpy,
    multisigUpdateSpy,
    routingCreateSpy,
    routingUpdateSpy,
  };
}

// ============================================================================
// RoutingIsmWriter Test Fixture
// ============================================================================

export interface RoutingIsmWriterTestFixture extends BaseTestFixture {
  mockArtifactManager: IRawIsmArtifactManager;
  mockIsmWriter: MockIsmWriter;
  ismWriterCreateSpy: Sinon.SinonStub;
  ismWriterApplyUpdateSpy: Sinon.SinonStub;
  rawRoutingUpdateSpy: Sinon.SinonStub;
}

/** Minimal IsmWriter interface for mocking in RoutingIsmWriter tests */
export interface MockIsmWriter {
  create: Sinon.SinonStub;
  update: Sinon.SinonStub;
  applyUpdate: Sinon.SinonStub;
  read: Sinon.SinonStub;
}

/**
 * Creates a test fixture for RoutingIsmWriter tests.
 * Sets up mocks for nested ISM operations with address-based routing
 * to avoid infinite recursion in IsmReader.expandRoutingIsm().
 */
export async function createRoutingIsmWriterTestFixture(): Promise<RoutingIsmWriterTestFixture> {
  const base = await createBaseFixture();

  // Create spies for IsmWriter
  const ismWriterCreateSpy = Sinon.stub().callsFake(async (artifact) => [
    createDeployedArtifact(artifact.config, TEST_ADDRESSES.NEW_ISM),
    [] as TxReceipt[],
  ]);
  const ismWriterApplyUpdateSpy = Sinon.stub();

  const mockIsmWriter: MockIsmWriter = {
    create: ismWriterCreateSpy,
    update: Sinon.stub().resolves([]),
    applyUpdate: ismWriterApplyUpdateSpy,
    read: Sinon.stub().resolves(
      createDeployedArtifact(
        TEST_CONFIGS.multisig.domain2,
        TEST_ADDRESSES.DOMAIN2_ISM,
      ),
    ),
  };

  // Create spy for raw routing writer
  const rawRoutingUpdateSpy = Sinon.stub().resolves([
    { annotation: 'routing ism update tx' } as AnnotatedTx,
  ]);

  const mockRawRoutingWriter: ArtifactWriter<
    RawRoutingIsmArtifactConfig,
    DeployedIsmAddress
  > = {
    create: Sinon.stub().resolves([
      createDeployedArtifact(
        TEST_CONFIGS.routing.empty,
        TEST_ADDRESSES.ROUTING_ISM,
      ),
      [] as TxReceipt[],
    ]),
    update: rawRoutingUpdateSpy,
    read: Sinon.stub().resolves({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        ...TEST_CONFIGS.routing.empty,
        domains: {
          2: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: TEST_ADDRESSES.DOMAIN2_ISM },
          },
        },
      },
      deployed: { address: TEST_ADDRESSES.ROUTING_ISM },
    } satisfies DeployedRawIsmArtifact),
  };

  // Create mock artifact manager - returns different ISM types based on address
  // This is critical to avoid infinite recursion in IsmReader.expandRoutingIsm()
  const readIsmStub = Sinon.stub().callsFake(async (address: string) => {
    if (address === TEST_ADDRESSES.ROUTING_ISM) {
      return {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          ...TEST_CONFIGS.routing.empty,
          domains: {
            2: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: TEST_ADDRESSES.DOMAIN2_ISM },
            },
          },
        },
        deployed: { address: TEST_ADDRESSES.ROUTING_ISM },
      } satisfies DeployedRawIsmArtifact;
    } else if (address === TEST_ADDRESSES.DOMAIN2_ISM) {
      return createDeployedArtifact(
        TEST_CONFIGS.multisig.domain2,
        TEST_ADDRESSES.DOMAIN2_ISM,
      );
    }
    throw new Error(`Unexpected readIsm call for address: ${address}`);
  });

  const mockArtifactManager: IRawIsmArtifactManager = {
    readIsm: readIsmStub,

    createReader: ((_type: string) => {
      return mockRawRoutingWriter as ArtifactReader<
        RawIsmArtifactConfig,
        DeployedIsmAddress
      >;
    }) as IRawIsmArtifactManager['createReader'],

    createWriter: ((type: string, _signer: unknown) => {
      if (type === AltVM.IsmType.ROUTING) {
        return mockRawRoutingWriter as ArtifactWriter<
          RawIsmArtifactConfig,
          DeployedIsmAddress
        >;
      }
      throw new Error(`Unexpected createWriter for ${type}`);
    }) as IRawIsmArtifactManager['createWriter'],
  } satisfies Partial<IRawIsmArtifactManager> as IRawIsmArtifactManager;

  return {
    ...base,
    mockArtifactManager,
    mockIsmWriter,
    ismWriterCreateSpy,
    ismWriterApplyUpdateSpy,
    rawRoutingUpdateSpy,
  };
}
