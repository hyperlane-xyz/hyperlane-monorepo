import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon from 'sinon';

import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactNew,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  ArtifactState,
  isArtifactDeployed,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import type {
  DeployedHookArtifact,
  HookArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import type {
  CompositeIsmArtifactConfig,
  CompositeIsmNodeArtifactConfig,
  DeployedIsmArtifact,
  IsmArtifactConfig,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { CompositeIsmNodeType, IsmType } from '@hyperlane-xyz/provider-sdk/ism';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  type DeployedFeeArtifact,
  type FeeArtifactConfig,
  FeeParamsType,
  FeeStrategyType,
  FeeType,
  type IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import {
  ProtocolType,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import {
  type CollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  type DeployedWarpArtifact,
  type RawWarpArtifactConfig,
  TokenType,
  type WarpArtifactConfig,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import { WarpTokenWriter } from './warp-writer.js';

chai.use(chaiAsPromised);

const TEST_CHAIN = 'test1';
const TEST_DOMAIN_ID = 1;
const REMOTE_DOMAIN_ID_1 = 1234;
const REMOTE_DOMAIN_ID_2 = 4321;
const REMOTE_DOMAIN_ID_3 = 5321;
const TOKEN_ADDRESS =
  '0x726f757465725f61707000000000000000000000000000010000000000000000';
const OWNER_ADDRESS = 'hyp1jq304cthpx0lwhpqzrdjrcza559ukyy3sc4dw5';
const MAILBOX_ADDRESS =
  '0x68797065726c616e650000000000000000000000000000000000000000000000';
const ISM_ADDRESS = '0x1234';
const HOOK_ADDRESS = '0x5678';
const FEE_ADDRESS = '0x9abc';

// Type-safe mock implementations
type MockRawWarpWriter = ArtifactWriter<
  RawWarpArtifactConfig,
  DeployedWarpAddress
>;

interface MockArtifactManager {
  readWarpToken: Sinon.SinonStub<[string], Promise<DeployedWarpArtifact>>;
  createWriter: Sinon.SinonStub<
    [WarpType, ISigner<AnnotatedTx, TxReceipt>],
    MockRawWarpWriter
  >;
  supportsHookUpdates: Sinon.SinonStub<[], boolean>;
}

interface MockIsmWriter {
  create: Sinon.SinonStub<
    [ArtifactNew<IsmArtifactConfig>],
    Promise<[DeployedIsmArtifact, TxReceipt[]]>
  >;
  update: Sinon.SinonStub<[DeployedIsmArtifact], Promise<AnnotatedTx[]>>;
  read: Sinon.SinonStub;
}

interface MockHookWriter {
  create: Sinon.SinonStub<
    [ArtifactNew<HookArtifactConfig>],
    Promise<[DeployedHookArtifact, TxReceipt[]]>
  >;
  update: Sinon.SinonStub<[DeployedHookArtifact], Promise<AnnotatedTx[]>>;
  read: Sinon.SinonStub;
}

interface MockChainLookup {
  getChainMetadata: Sinon.SinonStub;
  getChainName: Sinon.SinonStub;
  getDomainId: Sinon.SinonStub;
}

describe('WarpTokenWriter', () => {
  let writer: WarpTokenWriter;
  let mockArtifactManager: MockArtifactManager;
  let mockSigner: ISigner<AnnotatedTx, TxReceipt>;
  let mockIsmWriter: MockIsmWriter;
  let mockHookWriter: MockHookWriter;
  let mockChainLookup: MockChainLookup;
  let readStub: Sinon.SinonStub<[string], Promise<DeployedWarpArtifact>>;

  const actualConfig: CollateralWarpArtifactConfig = {
    type: TokenType.collateral,
    owner: OWNER_ADDRESS,
    mailbox: MAILBOX_ADDRESS,
    token: 'uhyp',
    remoteRouters: {
      [REMOTE_DOMAIN_ID_1]: {
        address: TOKEN_ADDRESS,
      },
    },
    destinationGas: {
      [REMOTE_DOMAIN_ID_1]: '200000',
    },
  };

  const baseDeployedArtifact: DeployedWarpArtifact = {
    artifactState: ArtifactState.DEPLOYED,
    config: actualConfig,
    deployed: { address: TOKEN_ADDRESS },
  };

  const chainMetadata: ChainMetadataForAltVM = {
    name: TEST_CHAIN,
    chainId: 1,
    domainId: TEST_DOMAIN_ID,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://localhost:8545' }],
  };

  beforeEach(() => {
    // Create mock artifact manager
    mockArtifactManager = {
      readWarpToken: Sinon.stub<[string], Promise<DeployedWarpArtifact>>(),
      createWriter: Sinon.stub<
        [WarpType, ISigner<AnnotatedTx, TxReceipt>],
        MockRawWarpWriter
      >(),
      supportsHookUpdates: Sinon.stub<[], boolean>().returns(true),
    };

    // Create minimal mock signer
    mockSigner = {
      getSignerAddress: () => OWNER_ADDRESS,
    } as ISigner<AnnotatedTx, TxReceipt>;

    // Create mock chain lookup
    mockChainLookup = {
      getChainMetadata: Sinon.stub().returns({
        name: TEST_CHAIN,
        domainId: TEST_DOMAIN_ID,
        protocol: ProtocolType.Ethereum,
      }),
      getChainName: Sinon.stub().returns(TEST_CHAIN),
      getDomainId: Sinon.stub().returns(TEST_DOMAIN_ID),
    };

    // Create mock ISM and Hook writers FIRST
    mockIsmWriter = {
      create: Sinon.stub<
        [ArtifactNew<IsmArtifactConfig>],
        Promise<[DeployedIsmArtifact, TxReceipt[]]>
      >(),
      update: Sinon.stub<[DeployedIsmArtifact], Promise<AnnotatedTx[]>>(),
      read: Sinon.stub(),
    };

    mockHookWriter = {
      create: Sinon.stub<
        [ArtifactNew<HookArtifactConfig>],
        Promise<[DeployedHookArtifact, TxReceipt[]]>
      >(),
      update: Sinon.stub<[DeployedHookArtifact], Promise<AnnotatedTx[]>>(),
      read: Sinon.stub(),
    };

    // Create writer instance - manually to bypass protocol provider
    writer = Object.create(WarpTokenWriter.prototype);
    Object.assign(writer, {
      artifactManager: mockArtifactManager,
      chainMetadata,
      chainLookup: mockChainLookup,
      signer: mockSigner,
      ismWriter: mockIsmWriter,
      hookWriterFactory: () => mockHookWriter,
    });

    // Default read stub - returns current config
    readStub = Sinon.stub(writer, 'read').resolves(baseDeployedArtifact);
  });

  afterEach(() => {
    Sinon.restore();
  });

  describe('update() - Router Management', () => {
    interface RouterUpdateTestCase {
      name: string;
      configOverrides: Partial<CollateralWarpArtifactConfig>;
      expectedTxCount: number;
      assertion?: (txs: AnnotatedTx[]) => void;
    }

    const createMockTx = (annotation: string): AnnotatedTx => ({
      annotation,
      to: TOKEN_ADDRESS,
      data: '0x',
    });

    const routerTestCases: RouterUpdateTestCase[] = [
      {
        name: 'no updates needed if config is the same',
        configOverrides: {},
        expectedTxCount: 0,
      },
      {
        name: 'new remote router',
        configOverrides: {
          remoteRouters: {
            ...actualConfig.remoteRouters,
            [REMOTE_DOMAIN_ID_2]: { address: '0xNEWROUTER' },
          },
          destinationGas: {
            ...actualConfig.destinationGas,
            [REMOTE_DOMAIN_ID_2]: '300000',
          },
        },
        expectedTxCount: 1,
        assertion: (txs) => {
          expect(txs[0].annotation).to.include('router');
        },
      },
      {
        name: 'multiple new remote routers',
        configOverrides: {
          remoteRouters: {
            ...actualConfig.remoteRouters,
            [REMOTE_DOMAIN_ID_2]: { address: '0xNEWROUTER1' },
            [REMOTE_DOMAIN_ID_3]: { address: '0xNEWROUTER2' },
          },
          destinationGas: {
            ...actualConfig.destinationGas,
            [REMOTE_DOMAIN_ID_2]: '300000',
            [REMOTE_DOMAIN_ID_3]: '400000',
          },
        },
        expectedTxCount: 2,
        assertion: (txs) => {
          expect(txs).to.have.lengthOf(2);
          txs.forEach((tx) => {
            expect(tx.annotation).to.include('router');
          });
        },
      },
      {
        name: 'remove existing remote router',
        configOverrides: {
          remoteRouters: {},
          destinationGas: {},
        },
        expectedTxCount: 1,
      },
      {
        name: 'update existing router address',
        configOverrides: {
          remoteRouters: {
            [REMOTE_DOMAIN_ID_1]: { address: '0xUPDATEDROUTER' },
          },
        },
        expectedTxCount: 2, // unenroll + enroll
      },
      {
        name: 'update existing router gas',
        configOverrides: {
          destinationGas: {
            [REMOTE_DOMAIN_ID_1]: '999999',
          },
        },
        expectedTxCount: 2, // unenroll + enroll with new gas
      },
      {
        name: 'remove and add remote router at the same time',
        configOverrides: {
          remoteRouters: {
            [REMOTE_DOMAIN_ID_2]: { address: '0xNEWROUTER' },
          },
          destinationGas: {
            [REMOTE_DOMAIN_ID_2]: '300000',
          },
        },
        expectedTxCount: 2, // remove old + add new
      },
    ];

    routerTestCases.forEach(
      ({ name, configOverrides, expectedTxCount, assertion }) => {
        it(name, async () => {
          // Setup mock writer
          const mockWriter: MockRawWarpWriter = {
            read: Sinon.stub(),
            create: Sinon.stub(),
            update: Sinon.stub().resolves(
              Array(expectedTxCount)
                .fill(null)
                .map((_, i) => createMockTx(`Update router ${i}`)),
            ),
          };

          mockArtifactManager.createWriter.returns(mockWriter);

          // Execute update
          const artifact: DeployedWarpArtifact = {
            ...baseDeployedArtifact,
            config: { ...actualConfig, ...configOverrides },
          };

          const updateTxs = await writer.update(artifact);

          // Assertions
          expect(updateTxs).to.have.lengthOf(expectedTxCount);

          if (assertion) {
            assertion(updateTxs);
          }
        });
      },
    );
  });

  describe('update() - Ownership Changes', () => {
    it('should update ownership', async () => {
      const newOwner = '0x9999999999999999999999999999999999999999';
      const configWithNewOwner: CollateralWarpArtifactConfig = {
        ...actualConfig,
        owner: newOwner,
      };

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([
          {
            annotation: 'Transfer ownership',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
        ]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithNewOwner,
      };

      const updateTxs = await writer.update(artifact);

      expect(updateTxs).to.have.lengthOf(1);
      expect(updateTxs[0].annotation).to.match(/ownership/i);
    });
  });

  describe('update() - ISM Updates', () => {
    const createIsmConfig = (
      type: typeof IsmType.MESSAGE_ID_MULTISIG,
      validators: string[],
    ): IsmArtifactConfig => ({
      type,
      validators,
      threshold: 1,
    });

    it('should deploy new ISM', async () => {
      const newIsmConfig = createIsmConfig(IsmType.MESSAGE_ID_MULTISIG, [
        '0xVALIDATOR',
      ]);

      const configWithIsm: WarpArtifactConfig = {
        ...actualConfig,
        interchainSecurityModule: {
          artifactState: ArtifactState.NEW,
          config: newIsmConfig,
        },
      };

      // Mock ISM creation
      const deployedIsm: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: newIsmConfig,
        deployed: { address: ISM_ADDRESS },
      };

      mockIsmWriter.create.resolves([deployedIsm, []]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([
          {
            annotation: 'Set ISM',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
        ]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithIsm,
      };

      const updateTxs = await writer.update(artifact);

      expect(mockIsmWriter.create.callCount).to.equal(1);
      expect(updateTxs.length).to.be.greaterThan(0);
    });

    it('should update existing ISM in-place when type is unchanged', async () => {
      const ismConfig = createIsmConfig(IsmType.MESSAGE_ID_MULTISIG, [
        '0xVALIDATOR1',
      ]);

      const currentArtifactWithIsm: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: {
          ...actualConfig,
          interchainSecurityModule: {
            artifactState: ArtifactState.DEPLOYED,
            config: ismConfig,
            deployed: { address: ISM_ADDRESS },
          },
        },
      };

      readStub.restore();
      readStub = Sinon.stub(writer, 'read').resolves(currentArtifactWithIsm);

      mockIsmWriter.update.resolves([]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: {
          ...actualConfig,
          interchainSecurityModule: {
            artifactState: ArtifactState.DEPLOYED,
            config: ismConfig,
            deployed: { address: ISM_ADDRESS },
          },
        },
      };

      await writer.update(artifact);

      expect(mockIsmWriter.create.callCount).to.equal(0);
      expect(mockIsmWriter.update.callCount).to.equal(1);
    });

    it('should replace existing ISM when type changes', async () => {
      // Setup current artifact with existing ISM
      const currentIsmConfig = createIsmConfig(IsmType.MESSAGE_ID_MULTISIG, [
        '0xVALIDATOR1',
      ]);

      const currentArtifactWithIsm: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: {
          ...actualConfig,
          interchainSecurityModule: {
            artifactState: ArtifactState.DEPLOYED,
            config: currentIsmConfig,
            deployed: { address: ISM_ADDRESS },
          },
        },
      };

      readStub.restore();
      readStub = Sinon.stub(writer, 'read').resolves(currentArtifactWithIsm);

      // New ISM config
      const newIsmConfig: IsmArtifactConfig = {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        validators: ['0xVALIDATOR2'],
        threshold: 1,
      };

      const configWithNewIsm: WarpArtifactConfig = {
        ...actualConfig,
        interchainSecurityModule: {
          artifactState: ArtifactState.NEW,
          config: newIsmConfig,
        },
      };

      // Mock ISM creation (new ISM type)
      const newIsmAddress = '0x0000000000000000000000000000000000000004';
      const deployedNewIsm: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: newIsmConfig,
        deployed: { address: newIsmAddress },
      };

      mockIsmWriter.create.resolves([deployedNewIsm, []]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([
          {
            annotation: 'Update ISM',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
        ]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithNewIsm,
      };

      const updateTxs = await writer.update(artifact);

      expect(mockIsmWriter.create.callCount).to.equal(1);
      expect(updateTxs.length).to.be.greaterThan(0);
    });

    it('should treat omitted ISM and zero-address ISM equivalently', async () => {
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([]),
      };
      mockArtifactManager.createWriter.returns(mockWriter);

      // Case 1: no ISM
      const artifactNoIsm: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: { ...actualConfig, interchainSecurityModule: undefined },
      };
      await writer.update(artifactNoIsm);
      const createCountAfterNoIsm = mockIsmWriter.create.callCount;

      // Case 2: zero-address ISM (UNDERIVED — treated as pass-through)
      const artifactZeroIsm: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: {
          ...actualConfig,
          interchainSecurityModule: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: ZERO_ADDRESS },
          },
        },
      };
      await writer.update(artifactZeroIsm);

      // Neither case should trigger ISM creation
      expect(mockIsmWriter.create.callCount).to.equal(createCountAfterNoIsm);
      expect(mockIsmWriter.create.callCount).to.equal(0);
    });
  });

  describe('rateLimited recipient resolution', () => {
    const COMPOSITE_OWNER = OWNER_ADDRESS;
    const OTHER_RECIPIENT = `0x${'9999'.padStart(64, '0')}`;

    const rateLimited = (recipient?: string): CompositeIsmNodeArtifactConfig =>
      recipient === undefined
        ? {
            type: CompositeIsmNodeType.RATE_LIMITED,
            maxCapacity: '86400',
            mailbox: MAILBOX_ADDRESS,
          }
        : {
            type: CompositeIsmNodeType.RATE_LIMITED,
            maxCapacity: '86400',
            mailbox: MAILBOX_ADDRESS,
            recipient,
          };

    // Nested one level down so the tests exercise the recursive walk rather
    // than a root-only special case.
    const compositeWith = (
      node: CompositeIsmNodeArtifactConfig,
    ): CompositeIsmArtifactConfig => ({
      type: IsmType.COMPOSITE,
      owner: COMPOSITE_OWNER,
      root: {
        type: CompositeIsmNodeType.AGGREGATION,
        threshold: 1,
        subIsms: [{ type: CompositeIsmNodeType.TEST, accept: true }, node],
      },
    });

    const extractRateLimited = (
      config: IsmArtifactConfig,
    ): CompositeIsmNodeArtifactConfig => {
      assert(config.type === IsmType.COMPOSITE, 'expected compositeIsm');
      assert(
        config.root.type === CompositeIsmNodeType.AGGREGATION,
        'expected aggregation root',
      );
      return config.root.subIsms[1];
    };

    const deployedCompositeIsm = (
      config: CompositeIsmArtifactConfig,
    ): DeployedIsmArtifact => ({
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: ISM_ADDRESS },
    });

    const routingWith = (
      nestedConfig: IsmArtifactConfig,
    ): RoutingIsmArtifactConfig => ({
      type: IsmType.ROUTING,
      owner: COMPOSITE_OWNER,
      domains: {
        [REMOTE_DOMAIN_ID_1]: {
          artifactState: ArtifactState.NEW,
          config: nestedConfig,
        },
      },
    });

    const extractRoutingDomain = (
      config: IsmArtifactConfig,
    ): IsmArtifactConfig => {
      assert(config.type === IsmType.ROUTING, 'expected domainRoutingIsm');
      const domainIsm = config.domains[REMOTE_DOMAIN_ID_1];
      assert(domainIsm, `expected domain ${REMOTE_DOMAIN_ID_1}`);
      assert(!isArtifactUnderived(domainIsm), 'expected expanded domain ISM');
      return domainIsm.config;
    };

    // Stub-typed view of MockRawWarpWriter so the ordering assertions below
    // can reach Sinon's call bookkeeping.
    interface StubbedRawWarpWriter {
      read: Sinon.SinonStub;
      create: Sinon.SinonStub;
      update: Sinon.SinonStub;
    }

    let warpWriterStub: StubbedRawWarpWriter;
    let sendStub: Sinon.SinonStub;

    beforeEach(() => {
      sendStub = Sinon.stub().resolves({});
      Object.assign(mockSigner, { sendAndConfirmTransaction: sendStub });

      warpWriterStub = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: actualConfig,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub().resolves([]),
      } satisfies MockRawWarpWriter;
      mockArtifactManager.createWriter.returns(warpWriterStub);
      mockIsmWriter.update.resolves([]);
    });

    describe('create()', () => {
      it('deploys the ISM after the router and points every recipient at it', async () => {
        const ismConfig = compositeWith(rateLimited());
        mockIsmWriter.create.resolves([deployedCompositeIsm(ismConfig), []]);

        await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: ismConfig,
            },
          },
        });

        expect(mockIsmWriter.create.callCount).to.equal(1);
        expect(warpWriterStub.create.calledBefore(mockIsmWriter.create)).to.be
          .true;
        expect(
          extractRateLimited(mockIsmWriter.create.firstCall.args[0].config),
        ).to.deep.equal(rateLimited(TOKEN_ADDRESS));
      });

      it('defers and resolves a composite nested inside a domainRoutingIsm artifact', async () => {
        const routingConfig = routingWith(compositeWith(rateLimited()));
        mockIsmWriter.create.resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: routingConfig,
            deployed: { address: ISM_ADDRESS },
          },
          [],
        ]);

        await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: routingConfig,
            },
          },
        });

        expect(warpWriterStub.create.calledBefore(mockIsmWriter.create)).to.be
          .true;
        const rawConfig = warpWriterStub.create.firstCall.args[0].config;
        expect(rawConfig.interchainSecurityModule).to.be.undefined;
        expect(rawConfig.remoteRouters).to.deep.equal(
          actualConfig.remoteRouters,
        );

        const resolvedRouting = mockIsmWriter.create.firstCall.args[0].config;
        const nestedComposite = extractRoutingDomain(resolvedRouting);
        expect(extractRateLimited(nestedComposite)).to.deep.equal(
          rateLimited(TOKEN_ADDRESS),
        );
      });

      it('preserves a DEPLOYED descendant of a NEW routing ISM', async () => {
        const deployedDomainIsm = deployedCompositeIsm(
          compositeWith(rateLimited(TOKEN_ADDRESS)),
        );
        const routingConfig: RoutingIsmArtifactConfig = {
          type: IsmType.ROUTING,
          owner: COMPOSITE_OWNER,
          domains: { [REMOTE_DOMAIN_ID_1]: deployedDomainIsm },
        };
        mockIsmWriter.create.resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: routingConfig,
            deployed: { address: ISM_ADDRESS },
          },
          [],
        ]);

        await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: routingConfig,
            },
          },
        });

        const resolved = mockIsmWriter.create.firstCall.args[0].config;
        assert(resolved.type === IsmType.ROUTING, 'expected routing ISM');
        expect(resolved.domains[REMOTE_DOMAIN_ID_1]).to.equal(
          deployedDomainIsm,
        );
      });

      it('preserves an UNDERIVED descendant of a NEW routing ISM', async () => {
        const underivedDomainIsm = {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ISM_ADDRESS },
        } satisfies RoutingIsmArtifactConfig['domains'][number];
        const routingConfig: RoutingIsmArtifactConfig = {
          type: IsmType.ROUTING,
          owner: COMPOSITE_OWNER,
          domains: { [REMOTE_DOMAIN_ID_1]: underivedDomainIsm },
        };
        mockIsmWriter.create.resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: routingConfig,
            deployed: { address: ISM_ADDRESS },
          },
          [],
        ]);

        await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: routingConfig,
            },
          },
        });

        const resolved = mockIsmWriter.create.firstCall.args[0].config;
        assert(resolved.type === IsmType.ROUTING, 'expected routing ISM');
        expect(resolved.domains[REMOTE_DOMAIN_ID_1]).to.equal(
          underivedDomainIsm,
        );
      });

      it('validates a rateLimited descendant in a DEPLOYED routing ISM', async () => {
        const deployedDomainIsm = deployedCompositeIsm(
          compositeWith(rateLimited(TOKEN_ADDRESS)),
        );
        const routingIsm: DeployedIsmArtifact = {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: IsmType.ROUTING,
            owner: COMPOSITE_OWNER,
            domains: { [REMOTE_DOMAIN_ID_1]: deployedDomainIsm },
          },
          deployed: { address: ISM_ADDRESS },
        };

        const [deployed] = await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: routingIsm,
          },
        });

        expect(mockIsmWriter.create.callCount).to.equal(0);
        expect(mockIsmWriter.update.callCount).to.equal(0);
        expect(deployed.config.interchainSecurityModule).to.equal(routingIsm);
      });

      it('rejects a mismatched rateLimited descendant in a DEPLOYED routing ISM', async () => {
        const routingIsm: DeployedIsmArtifact = {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: IsmType.ROUTING,
            owner: COMPOSITE_OWNER,
            domains: {
              [REMOTE_DOMAIN_ID_1]: deployedCompositeIsm(
                compositeWith(rateLimited(OTHER_RECIPIENT)),
              ),
            },
          },
          deployed: { address: ISM_ADDRESS },
        };

        await expect(
          writer.create({
            artifactState: ArtifactState.NEW,
            config: {
              ...actualConfig,
              interchainSecurityModule: routingIsm,
            },
          }),
        ).to.be.rejectedWith(/does not match/);

        expect(warpWriterStub.create.callCount).to.equal(1);
        expect(mockIsmWriter.create.callCount).to.equal(0);
      });

      it('withholds the NEW ISM but preserves the router config', async () => {
        const ismConfig = compositeWith(rateLimited());
        mockIsmWriter.create.resolves([deployedCompositeIsm(ismConfig), []]);

        const [deployed] = await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: ismConfig,
            },
          },
        });

        const rawConfig = warpWriterStub.create.firstCall.args[0].config;
        expect(rawConfig.interchainSecurityModule).to.be.undefined;
        expect(rawConfig.remoteRouters).to.deep.equal(
          actualConfig.remoteRouters,
        );
        expect(rawConfig.destinationGas).to.deep.equal(
          actualConfig.destinationGas,
        );
        expect(deployed.config.remoteRouters).to.deep.equal(
          actualConfig.remoteRouters,
        );
        expect(deployed.config.destinationGas).to.deep.equal(
          actualConfig.destinationGas,
        );
        expect(deployed.config.interchainSecurityModule).to.deep.equal(
          deployedCompositeIsm(ismConfig),
        );
      });

      it('rejects a hand-written recipient before deploying anything', async () => {
        const ismConfig = compositeWith(rateLimited(TOKEN_ADDRESS));

        await expect(
          writer.create({
            artifactState: ArtifactState.NEW,
            config: {
              ...actualConfig,
              interchainSecurityModule: {
                artifactState: ArtifactState.NEW,
                config: ismConfig,
              },
            },
          }),
        ).to.be.rejectedWith(/recipient/);

        expect(mockIsmWriter.create.callCount).to.equal(0);
        expect(warpWriterStub.create.callCount).to.equal(0);
      });

      it('post-deploys a composite ISM without a rateLimited node', async () => {
        const ismConfig: CompositeIsmArtifactConfig = {
          type: IsmType.COMPOSITE,
          owner: COMPOSITE_OWNER,
          root: { type: CompositeIsmNodeType.TEST, accept: true },
        };
        mockIsmWriter.create.resolves([deployedCompositeIsm(ismConfig), []]);

        await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: ismConfig,
            },
          },
        });

        expect(warpWriterStub.create.calledBefore(mockIsmWriter.create)).to.be
          .true;
        const rawConfig = warpWriterStub.create.firstCall.args[0].config;
        expect(rawConfig.interchainSecurityModule).to.be.undefined;
        expect(rawConfig.remoteRouters).to.deep.equal(
          actualConfig.remoteRouters,
        );
      });

      it('post-deploys a non-composite ISM', async () => {
        const ismConfig: IsmArtifactConfig = { type: IsmType.TEST_ISM };
        mockIsmWriter.create.resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: ismConfig,
            deployed: { address: ISM_ADDRESS },
          },
          [],
        ]);

        await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: ismConfig,
            },
          },
        });

        expect(warpWriterStub.create.calledBefore(mockIsmWriter.create)).to.be
          .true;
        const rawConfig = warpWriterStub.create.firstCall.args[0].config;
        expect(rawConfig.interchainSecurityModule).to.be.undefined;
        expect(rawConfig.destinationGas).to.deep.equal(
          actualConfig.destinationGas,
        );
      });
    });

    describe('update()', () => {
      it('fills an unset recipient with the existing router address', async () => {
        const ismConfig = compositeWith(rateLimited());
        mockIsmWriter.create.resolves([deployedCompositeIsm(ismConfig), []]);

        await writer.update({
          ...baseDeployedArtifact,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: ismConfig,
            },
          },
        });

        expect(mockIsmWriter.create.callCount).to.equal(1);
        expect(
          extractRateLimited(mockIsmWriter.create.firstCall.args[0].config),
        ).to.deep.equal(rateLimited(TOKEN_ADDRESS));
      });

      it('resolves a composite nested inside a domainRoutingIsm artifact', async () => {
        const routingConfig = routingWith(compositeWith(rateLimited()));
        mockIsmWriter.create.resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: routingConfig,
            deployed: { address: ISM_ADDRESS },
          },
          [],
        ]);

        await writer.update({
          ...baseDeployedArtifact,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: routingConfig,
            },
          },
        });

        const resolvedRouting = mockIsmWriter.create.firstCall.args[0].config;
        const nestedComposite = extractRoutingDomain(resolvedRouting);
        expect(extractRateLimited(nestedComposite)).to.deep.equal(
          rateLimited(TOKEN_ADDRESS),
        );
      });

      it('accepts attaching a new composite ISM whose recipient names the existing router', async () => {
        const ismConfig = compositeWith(rateLimited(TOKEN_ADDRESS));
        mockIsmWriter.create.resolves([deployedCompositeIsm(ismConfig), []]);

        await writer.update({
          ...baseDeployedArtifact,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.NEW,
              config: ismConfig,
            },
          },
        });

        expect(mockIsmWriter.create.callCount).to.equal(1);
        expect(
          extractRateLimited(mockIsmWriter.create.firstCall.args[0].config),
        ).to.deep.equal(rateLimited(TOKEN_ADDRESS));
      });

      it('accepts an already-deployed composite ISM whose recipient names the router', async () => {
        const ismConfig = compositeWith(rateLimited(TOKEN_ADDRESS));
        readStub.resolves({
          ...baseDeployedArtifact,
          config: {
            ...actualConfig,
            interchainSecurityModule: deployedCompositeIsm(ismConfig),
          },
        });

        await writer.update({
          ...baseDeployedArtifact,
          config: {
            ...actualConfig,
            interchainSecurityModule: deployedCompositeIsm(ismConfig),
          },
        });

        expect(mockIsmWriter.create.callCount).to.equal(0);
        expect(mockIsmWriter.update.callCount).to.equal(1);
        expect(
          extractRateLimited(mockIsmWriter.update.firstCall.args[0].config),
        ).to.deep.equal(rateLimited(TOKEN_ADDRESS));
      });

      it('rejects a recipient naming a different address', async () => {
        const ismConfig = compositeWith(rateLimited(OTHER_RECIPIENT));

        await expect(
          writer.update({
            ...baseDeployedArtifact,
            config: {
              ...actualConfig,
              interchainSecurityModule: {
                artifactState: ArtifactState.NEW,
                config: ismConfig,
              },
            },
          }),
        ).to.be.rejectedWith(TOKEN_ADDRESS);

        expect(mockIsmWriter.create.callCount).to.equal(0);
        expect(mockIsmWriter.update.callCount).to.equal(0);
      });

      it('leaves an ISM referenced only by address alone', async () => {
        const updateTxs = await writer.update({
          ...baseDeployedArtifact,
          config: {
            ...actualConfig,
            interchainSecurityModule: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: ISM_ADDRESS },
            },
          },
        });

        expect(mockIsmWriter.create.callCount).to.equal(0);
        expect(mockIsmWriter.update.callCount).to.equal(0);
        expect(updateTxs).to.deep.equal([]);
      });
    });
  });

  describe('update() - Hook Updates', () => {
    const merkleTreeHookConfig: HookArtifactConfig = {
      type: 'merkleTreeHook',
    };

    it('should deploy new hook when none existed before', async () => {
      const configWithHook: WarpArtifactConfig = {
        ...actualConfig,
        hook: {
          artifactState: ArtifactState.NEW,
          config: merkleTreeHookConfig,
        },
      };

      const deployedHook: DeployedHookArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: merkleTreeHookConfig,
        deployed: { address: HOOK_ADDRESS },
      };

      mockHookWriter.create.resolves([deployedHook, []]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([
          { annotation: 'Set hook', to: TOKEN_ADDRESS, data: '0x' },
        ]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithHook,
      };

      const updateTxs = await writer.update(artifact);

      expect(mockHookWriter.create.callCount).to.equal(1);
      expect(updateTxs.length).to.be.greaterThan(0);
    });

    it('should skip hook deployment when hook is underived (address reference)', async () => {
      const configWithUnderivedHook: WarpArtifactConfig = {
        ...actualConfig,
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: HOOK_ADDRESS },
        },
      };

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithUnderivedHook,
      };

      await writer.update(artifact);

      expect(mockHookWriter.create.called).to.be.false;
      expect(mockHookWriter.update.called).to.be.false;
    });

    it('should skip hook deployment when protocol does not support hook updates', async () => {
      mockArtifactManager.supportsHookUpdates.returns(false);

      const configWithHook: WarpArtifactConfig = {
        ...actualConfig,
        hook: {
          artifactState: ArtifactState.NEW,
          config: merkleTreeHookConfig,
        },
      };

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithHook,
      };

      await writer.update(artifact);

      expect(mockHookWriter.create.called).to.be.false;
      expect(mockHookWriter.update.called).to.be.false;
    });

    it('should handle hook + router updates in single call', async () => {
      const configWithHookAndRouter: WarpArtifactConfig = {
        ...actualConfig,
        hook: {
          artifactState: ArtifactState.NEW,
          config: merkleTreeHookConfig,
        },
        remoteRouters: {
          ...actualConfig.remoteRouters,
          [REMOTE_DOMAIN_ID_2]: { address: '0xNEWROUTER' },
        },
        destinationGas: {
          ...actualConfig.destinationGas,
          [REMOTE_DOMAIN_ID_2]: '300000',
        },
      };

      const deployedHook: DeployedHookArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: merkleTreeHookConfig,
        deployed: { address: HOOK_ADDRESS },
      };

      mockHookWriter.create.resolves([deployedHook, []]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([
          { annotation: 'Set hook', to: TOKEN_ADDRESS, data: '0x' },
          { annotation: 'Enroll router', to: TOKEN_ADDRESS, data: '0x' },
        ]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithHookAndRouter,
      };

      const updateTxs = await writer.update(artifact);

      expect(mockHookWriter.create.callCount).to.equal(1);
      expect(updateTxs.length).to.equal(2);
    });
  });

  describe('update() - Validation', () => {
    it('should reject changing token type', async () => {
      // Current artifact is collateral
      const currentArtifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: {
          ...actualConfig,
          type: TokenType.collateral,
        },
      };

      readStub.restore();
      readStub = Sinon.stub(writer, 'read').resolves(currentArtifact);

      // Try to change to synthetic
      const syntheticConfig: WarpArtifactConfig = {
        type: TokenType.synthetic,
        owner: OWNER_ADDRESS,
        mailbox: MAILBOX_ADDRESS,
        name: 'Synthetic Token',
        symbol: 'SYN',
        decimals: 18,
        remoteRouters: {},
        destinationGas: {},
      };

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: syntheticConfig,
      };

      await expect(writer.update(artifact)).to.be.rejectedWith(
        /Cannot change warp token type/,
      );
    });
  });

  describe('update() - Complex Scenarios', () => {
    it('should handle ISM + router updates in single call', async () => {
      const newIsmConfig: IsmArtifactConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ['0xVALIDATOR'],
        threshold: 1,
      };

      const configWithIsmAndRouter: WarpArtifactConfig = {
        ...actualConfig,
        interchainSecurityModule: {
          artifactState: ArtifactState.NEW,
          config: newIsmConfig,
        },
        remoteRouters: {
          ...actualConfig.remoteRouters,
          [REMOTE_DOMAIN_ID_2]: { address: '0xNEWROUTER' },
        },
        destinationGas: {
          ...actualConfig.destinationGas,
          [REMOTE_DOMAIN_ID_2]: '300000',
        },
      };

      // Mock ISM creation
      const deployedIsm: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: newIsmConfig,
        deployed: { address: ISM_ADDRESS },
      };

      mockIsmWriter.create.resolves([deployedIsm, []]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([
          {
            annotation: 'Set ISM',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
          {
            annotation: 'Enroll router',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
        ]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithIsmAndRouter,
      };

      const updateTxs = await writer.update(artifact);

      expect(mockIsmWriter.create.callCount).to.equal(1);
      expect(updateTxs.length).to.be.greaterThan(1);
    });

    it('should handle ownership + ISM + router updates', async () => {
      const newOwner = '0x9999999999999999999999999999999999999999';
      const newIsmConfig: IsmArtifactConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ['0xVALIDATOR'],
        threshold: 1,
      };

      const complexConfig: WarpArtifactConfig = {
        ...actualConfig,
        owner: newOwner,
        interchainSecurityModule: {
          artifactState: ArtifactState.NEW,
          config: newIsmConfig,
        },
        remoteRouters: {},
        destinationGas: {},
      };

      // Mock ISM creation
      const deployedIsm: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: newIsmConfig,
        deployed: { address: ISM_ADDRESS },
      };

      mockIsmWriter.create.resolves([deployedIsm, []]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([
          {
            annotation: 'Transfer ownership',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
          {
            annotation: 'Set ISM',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
          {
            annotation: 'Unenroll router',
            to: TOKEN_ADDRESS,
            data: '0x',
          },
        ]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: complexConfig,
      };

      const updateTxs = await writer.update(artifact);

      expect(mockIsmWriter.create.callCount).to.equal(1);
      expect(updateTxs.length).to.equal(3);
    });
  });

  describe('create()', () => {
    it('should create warp token without ISM', async () => {
      const mockWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: actualConfig,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub(),
      } satisfies MockRawWarpWriter;

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: actualConfig,
      };

      const [deployed, receipts] = await writer.create(artifact);

      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).to.equal(TOKEN_ADDRESS);
      expect(receipts).to.be.an('array');
      expect(mockWriter.create.callCount).to.equal(1);
    });

    it('should create warp token with new ISM', async () => {
      const newIsmConfig: IsmArtifactConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ['0xVALIDATOR'],
        threshold: 1,
      };

      const configWithIsm: WarpArtifactConfig = {
        ...actualConfig,
        interchainSecurityModule: {
          artifactState: ArtifactState.NEW,
          config: newIsmConfig,
        },
      };

      // Mock ISM creation
      const deployedIsm: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: newIsmConfig,
        deployed: { address: ISM_ADDRESS },
      };

      mockIsmWriter.create.resolves([deployedIsm, []]);
      mockIsmWriter.update.resolves([]);

      const mockWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: actualConfig,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub().resolves([]),
      } satisfies MockRawWarpWriter;

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithIsm,
      };

      const [deployed, receipts] = await writer.create(artifact);

      expect(mockIsmWriter.create.callCount).to.equal(1);
      expect(mockWriter.create.calledBefore(mockIsmWriter.create)).to.be.true;
      expect(
        mockWriter.create.firstCall.args[0].config.interchainSecurityModule,
      ).to.be.undefined;
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).to.equal(TOKEN_ADDRESS);
      expect(receipts).to.be.an('array');
    });

    it('should create warp token with existing ISM', async () => {
      const existingIsmConfig: IsmArtifactConfig = {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ['0xVALIDATOR'],
        threshold: 1,
      };

      const configWithExistingIsm: WarpArtifactConfig = {
        ...actualConfig,
        interchainSecurityModule: {
          artifactState: ArtifactState.DEPLOYED,
          config: existingIsmConfig,
          deployed: { address: ISM_ADDRESS },
        },
      };

      mockIsmWriter.update.resolves([]);
      const mockWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: actualConfig,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub().resolves([]),
      } satisfies MockRawWarpWriter;

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithExistingIsm,
      };

      const [deployed, receipts] = await writer.create(artifact);

      // Should not create new ISM
      expect(mockIsmWriter.create.called).to.be.false;
      expect(mockIsmWriter.update.called).to.be.false;
      expect(
        mockWriter.create.firstCall.args[0].config.interchainSecurityModule,
      ).to.be.undefined;
      expect(mockWriter.update.callCount).to.equal(1);
      expect(
        mockWriter.update.firstCall.args[0].config.interchainSecurityModule,
      ).to.deep.equal({
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: ISM_ADDRESS },
      });
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).to.equal(TOKEN_ADDRESS);
      expect(receipts).to.be.an('array');
    });
  });

  describe('create() - Hook', () => {
    const merkleTreeHookConfig: HookArtifactConfig = {
      type: 'merkleTreeHook',
    };

    it('should deploy hook before warp token when hook is new', async () => {
      const configWithHook: WarpArtifactConfig = {
        ...actualConfig,
        hook: {
          artifactState: ArtifactState.NEW,
          config: merkleTreeHookConfig,
        },
      };

      const hookReceipt: TxReceipt = { transactionHash: '0xHOOKTX' };
      const deployedHook: DeployedHookArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: merkleTreeHookConfig,
        deployed: { address: HOOK_ADDRESS },
      };

      mockHookWriter.create.resolves([deployedHook, [hookReceipt]]);

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: configWithHook,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub(),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithHook,
      };

      const [deployed, receipts] = await writer.create(artifact);

      expect(mockHookWriter.create.callCount).to.equal(1);
      expect(receipts).to.include(hookReceipt);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).to.equal(TOKEN_ADDRESS);
    });

    it('should reuse hook address when hook is already deployed', async () => {
      const configWithDeployedHook: WarpArtifactConfig = {
        ...actualConfig,
        hook: {
          artifactState: ArtifactState.DEPLOYED,
          config: merkleTreeHookConfig,
          deployed: { address: HOOK_ADDRESS },
        },
      };

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: configWithDeployedHook,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub(),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithDeployedHook,
      };

      const [deployed] = await writer.create(artifact);

      expect(mockHookWriter.create.called).to.be.false;
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    });

    it('should skip hook deployment when protocol does not support hooks', async () => {
      mockArtifactManager.supportsHookUpdates.returns(false);

      const configWithHook: WarpArtifactConfig = {
        ...actualConfig,
        hook: {
          artifactState: ArtifactState.NEW,
          config: merkleTreeHookConfig,
        },
      };

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: configWithHook,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub(),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithHook,
      };

      const [deployed] = await writer.create(artifact);

      expect(mockHookWriter.create.called).to.be.false;
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    });
  });

  describe('update() - Idempotency', () => {
    it('should return empty array when no changes needed', async () => {
      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: Sinon.stub().resolves([]),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: actualConfig,
      };

      const updateTxs = await writer.update(artifact);

      expect(updateTxs).to.be.an('array').that.is.empty;
    });
  });

  describe('create() - Fee', () => {
    const FEE_CREATE_PROTOCOL = 'fee-create-protocol' as ProtocolType;

    const feeCreateChainMetadata: ChainMetadataForAltVM = {
      name: TEST_CHAIN,
      chainId: 1,
      domainId: TEST_DOMAIN_ID,
      protocol: FEE_CREATE_PROTOCOL,
      rpcUrls: [{ http: 'http://localhost:8545' }],
    };

    let feeCreateWriter: WarpTokenWriter;
    let mockFeeCreateStub: Sinon.SinonStub;
    let mockFeeUpdateStubForCreate: Sinon.SinonStub;
    let currentFeeCreateManager: IRawFeeArtifactManager;

    const linearFeeConfig: FeeArtifactConfig = {
      type: FeeType.linear,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      params: { type: FeeParamsType.raw, maxFee: '1000', halfAmount: '500' },
    };

    const deployedFee: DeployedFeeArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: linearFeeConfig,
      deployed: { address: FEE_ADDRESS },
    };

    before(() => {
      if (!hasProtocol(FEE_CREATE_PROTOCOL)) {
        registerProtocol(FEE_CREATE_PROTOCOL, () => ({
          createProvider: Sinon.stub(),
          createSigner: Sinon.stub(),
          createSubmitter: Sinon.stub(),
          createIsmArtifactManager: Sinon.stub(),
          createHookArtifactManager: Sinon.stub(),
          createMailboxArtifactManager: Sinon.stub(),
          createValidatorAnnounceArtifactManager: Sinon.stub(),
          createFeeArtifactManager: () => currentFeeCreateManager,
          getMinGas: Sinon.stub(),
          createWarpArtifactManager: Sinon.stub(),
        }));
      }
    });

    beforeEach(() => {
      // Singleton stubs for the fee deployment performed by create().
      mockFeeCreateStub = Sinon.stub().resolves([deployedFee, []]);
      mockFeeUpdateStubForCreate = Sinon.stub().resolves([]);
      currentFeeCreateManager = {
        readFee: Sinon.stub().resolves(deployedFee),
        createReader: Sinon.stub(),
        createWriter: Sinon.stub().returns({
          read: Sinon.stub(),
          create: mockFeeCreateStub,
          update: mockFeeUpdateStubForCreate,
        }),
      };

      feeCreateWriter = Object.create(WarpTokenWriter.prototype);
      Object.assign(feeCreateWriter, {
        artifactManager: mockArtifactManager,
        chainMetadata: feeCreateChainMetadata,
        chainLookup: mockChainLookup,
        signer: mockSigner,
        ismWriter: mockIsmWriter,
        hookWriterFactory: () => mockHookWriter,
      });

      // this.update() inside create() reads current warp state; return a
      // warp with no fee so the diff emits exactly the SetFee attach.
      Sinon.stub(feeCreateWriter, 'read').resolves(baseDeployedArtifact);
    });

    it('should deploy warp without fee, then deploy fee and attach via update', async () => {
      const configWithFee: WarpArtifactConfig = {
        ...actualConfig,
        fee: {
          artifactState: ArtifactState.NEW,
          config: linearFeeConfig,
        },
      };

      const createStub = Sinon.stub().resolves([
        {
          artifactState: ArtifactState.DEPLOYED,
          config: actualConfig,
          deployed: { address: TOKEN_ADDRESS },
        },
        [],
      ]);
      const updateStub = Sinon.stub().resolves([]);

      mockArtifactManager.createWriter.returns({
        read: Sinon.stub(),
        create: createStub,
        update: updateStub,
      });

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithFee,
      };

      const [deployed] = await feeCreateWriter.create(artifact);

      // Warp should be deployed with fee=undefined; fee is attached after.
      const rawArtifactArg = createStub.firstCall.args[0];
      expect(rawArtifactArg.config.fee).to.be.undefined;

      // Fee writer's create should run post-warp with the warp's settlement
      // asset resolved from deployed.config.
      expect(mockFeeCreateStub.calledOnce).to.be.true;
      const feeArtifactArg = mockFeeCreateStub.firstCall.args[0];
      expect(feeArtifactArg.config.token).to.equal('uhyp');

      // Attach references the deployed fee by address. It must not mutate the
      // freshly deployed fee program through feeWriter.update().
      expect(mockFeeUpdateStubForCreate.called).to.be.false;
      expect(updateStub.calledOnce).to.be.true;
      expect(updateStub.firstCall.args[0].config.fee).to.deep.equal({
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: FEE_ADDRESS },
      });

      // Returned artifact should include the deployed fee.
      expect(deployed.config.fee).to.not.be.undefined;
    });

    it('should attach existing deployed fee via update without re-creating', async () => {
      const configWithDeployedFee: WarpArtifactConfig = {
        ...actualConfig,
        fee: {
          artifactState: ArtifactState.DEPLOYED,
          config: linearFeeConfig,
          deployed: { address: FEE_ADDRESS },
        },
      };

      const createStub = Sinon.stub().resolves([
        {
          artifactState: ArtifactState.DEPLOYED,
          config: actualConfig,
          deployed: { address: TOKEN_ADDRESS },
        },
        [],
      ]);

      mockArtifactManager.createWriter.returns({
        read: Sinon.stub(),
        create: createStub,
        update: Sinon.stub().resolves([]),
      });

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithDeployedFee,
      };

      const [deployed] = await feeCreateWriter.create(artifact);

      // Warp deployed without fee
      const rawArtifactArg = createStub.firstCall.args[0];
      expect(rawArtifactArg.config.fee).to.be.undefined;

      // No fresh fee deploy — user supplied a DEPLOYED artifact
      expect(mockFeeCreateStub.called).to.be.false;

      // Returned artifact passes the user-supplied DEPLOYED fee through
      const returnedFee = deployed.config.fee;
      assert(
        returnedFee && isArtifactDeployed(returnedFee),
        'Expected DEPLOYED fee artifact in returned config',
      );
      expect(returnedFee.deployed.address).to.equal(FEE_ADDRESS);
    });
  });

  describe('update() - Fee', () => {
    const FEE_TEST_PROTOCOL = 'fee-test-protocol' as ProtocolType;

    const feeChainMetadata: ChainMetadataForAltVM = {
      name: TEST_CHAIN,
      chainId: 1,
      domainId: TEST_DOMAIN_ID,
      protocol: FEE_TEST_PROTOCOL,
      rpcUrls: [{ http: 'http://localhost:8545' }],
    };

    let feeWriter: WarpTokenWriter;
    let feeReadStub: Sinon.SinonStub<[string], Promise<DeployedWarpArtifact>>;
    let mockFeeUpdateStub: Sinon.SinonStub;

    // Shared reference so the protocol factory always reads the latest mock
    let currentMockFeeArtifactManager: IRawFeeArtifactManager;

    const linearFeeConfig: FeeArtifactConfig = {
      type: FeeType.linear,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      params: { type: FeeParamsType.raw, maxFee: '1000', halfAmount: '500' },
    };

    const deployedFee: DeployedFeeArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: linearFeeConfig,
      deployed: { address: FEE_ADDRESS },
    };

    // Register once - factory reads currentMockFeeArtifactManager each time
    before(() => {
      if (!hasProtocol(FEE_TEST_PROTOCOL)) {
        registerProtocol(FEE_TEST_PROTOCOL, () => ({
          createProvider: Sinon.stub(),
          createSigner: Sinon.stub(),
          createSubmitter: Sinon.stub(),
          createIsmArtifactManager: Sinon.stub(),
          createHookArtifactManager: Sinon.stub(),
          createMailboxArtifactManager: Sinon.stub(),
          createValidatorAnnounceArtifactManager: Sinon.stub(),
          createFeeArtifactManager: () => currentMockFeeArtifactManager,
          getMinGas: Sinon.stub(),
          createWarpArtifactManager: Sinon.stub(),
        }));
      }
    });

    beforeEach(() => {
      mockFeeUpdateStub = Sinon.stub().resolves([]);

      const mockFeeArtifactWriter = {
        read: Sinon.stub().resolves(deployedFee),
        create: Sinon.stub().resolves([deployedFee, []]),
        update: mockFeeUpdateStub,
      };

      currentMockFeeArtifactManager = {
        readFee: Sinon.stub().resolves(deployedFee),
        createReader: Sinon.stub(),
        createWriter: Sinon.stub().returns(mockFeeArtifactWriter),
      };

      feeWriter = Object.create(WarpTokenWriter.prototype);
      Object.assign(feeWriter, {
        artifactManager: mockArtifactManager,
        chainMetadata: feeChainMetadata,
        chainLookup: mockChainLookup,
        signer: mockSigner,
        ismWriter: mockIsmWriter,
        hookWriterFactory: () => mockHookWriter,
      });

      feeReadStub = Sinon.stub(feeWriter, 'read').resolves(
        baseDeployedArtifact,
      );
    });

    it('should deploy new fee when fee is NEW', async () => {
      const configWithFee: WarpArtifactConfig = {
        ...actualConfig,
        fee: {
          artifactState: ArtifactState.NEW,
          config: linearFeeConfig,
        },
      };

      const updateStub = Sinon.stub().resolves([]);
      mockArtifactManager.createWriter.returns({
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: updateStub,
      });

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithFee,
      };

      await feeWriter.update(artifact);

      // Fee should have been deployed - raw artifact should have fee address
      const rawArtifactArg = updateStub.firstCall.args[0];
      expect(rawArtifactArg.config.fee).to.not.be.undefined;
      expect(rawArtifactArg.config.fee?.deployed.address).to.equal(FEE_ADDRESS);
    });

    it('should update existing routing fee in-place when DEPLOYED', async () => {
      const feeTx: AnnotatedTx = {
        annotation: 'Update fee routes',
        to: FEE_ADDRESS,
        data: '0x',
      };

      mockFeeUpdateStub.resolves([feeTx]);

      const currentRoutingFee: DeployedFeeArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: FeeType.routing,
          owner: '0xowner',
          beneficiary: '0xbeneficiary',
          routes: {},
        },
        deployed: { address: FEE_ADDRESS },
      };

      // Current on-chain state has a deployed routing fee
      feeReadStub.resolves({
        ...baseDeployedArtifact,
        config: {
          ...actualConfig,
          fee: currentRoutingFee,
        },
      });

      const configWithFee: WarpArtifactConfig = {
        ...actualConfig,
        fee: {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            type: FeeType.routing,
            owner: '0xnewowner',
            beneficiary: '0xbeneficiary',
            routes: {
              [REMOTE_DOMAIN_ID_1]: {
                type: FeeStrategyType.linear,
                params: {
                  type: FeeParamsType.raw,
                  maxFee: '1000',
                  halfAmount: '500',
                },
              },
            },
          },
          deployed: { address: FEE_ADDRESS },
        },
      };

      const warpUpdateStub = Sinon.stub().resolves([]);
      mockArtifactManager.createWriter.returns({
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: warpUpdateStub,
      });

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithFee,
      };

      const updateTxs = await feeWriter.update(artifact);

      // Fee update tx should be included
      expect(updateTxs).to.include(feeTx);

      // Fee writer should receive the warp's settlement asset on its config
      const feeArtifactArg = mockFeeUpdateStub.firstCall.args[0];
      expect(feeArtifactArg.config.token).to.equal('uhyp');
    });

    it('should pass through UNDERIVED fee without creating fee writer', async () => {
      const configWithUnderivedFee: WarpArtifactConfig = {
        ...actualConfig,
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: FEE_ADDRESS },
        },
      };

      const warpUpdateStub = Sinon.stub().resolves([]);
      mockArtifactManager.createWriter.returns({
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: warpUpdateStub,
      });

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithUnderivedFee,
      };

      await feeWriter.update(artifact);

      // UNDERIVED fee should be passed through as-is
      const rawArtifactArg = warpUpdateStub.firstCall.args[0];
      expect(rawArtifactArg.config.fee?.deployed.address).to.equal(FEE_ADDRESS);
    });
  });

  describe('Fee - unsupported protocol', () => {
    const NO_FEE_PROTOCOL = 'no-fee-protocol' as ProtocolType;

    const noFeeChainMetadata: ChainMetadataForAltVM = {
      name: TEST_CHAIN,
      chainId: 1,
      domainId: TEST_DOMAIN_ID,
      protocol: NO_FEE_PROTOCOL,
      rpcUrls: [{ http: 'http://localhost:8545' }],
    };

    let noFeeWriter: WarpTokenWriter;

    before(() => {
      if (!hasProtocol(NO_FEE_PROTOCOL)) {
        registerProtocol(NO_FEE_PROTOCOL, () => ({
          createProvider: Sinon.stub(),
          createSigner: Sinon.stub(),
          createSubmitter: Sinon.stub(),
          createIsmArtifactManager: Sinon.stub(),
          createHookArtifactManager: Sinon.stub(),
          createMailboxArtifactManager: Sinon.stub(),
          createValidatorAnnounceArtifactManager: Sinon.stub(),
          createFeeArtifactManager: Sinon.stub().returns(null),
          getMinGas: Sinon.stub(),
          createWarpArtifactManager: Sinon.stub(),
        }));
      }
    });

    beforeEach(() => {
      noFeeWriter = Object.create(WarpTokenWriter.prototype);
      Object.assign(noFeeWriter, {
        artifactManager: mockArtifactManager,
        chainMetadata: noFeeChainMetadata,
        chainLookup: mockChainLookup,
        signer: mockSigner,
        ismWriter: mockIsmWriter,
        hookWriterFactory: () => mockHookWriter,
      });

      Sinon.stub(noFeeWriter, 'read').resolves(baseDeployedArtifact);
    });

    const feeConfig: FeeArtifactConfig = {
      type: FeeType.linear,
      owner: '0xowner',
      beneficiary: '0xbeneficiary',
      params: { type: FeeParamsType.raw, maxFee: '1000', halfAmount: '500' },
    };

    const configWithFee: WarpArtifactConfig = {
      ...actualConfig,
      fee: {
        artifactState: ArtifactState.NEW,
        config: feeConfig,
      },
    };

    it('should ignore fee config on create when protocol does not support fees', async () => {
      const createStub = Sinon.stub().resolves([
        {
          artifactState: ArtifactState.DEPLOYED,
          config: actualConfig,
          deployed: { address: TOKEN_ADDRESS },
        },
        [],
      ]);

      mockArtifactManager.createWriter.returns({
        read: Sinon.stub(),
        create: createStub,
        update: Sinon.stub(),
      });

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithFee,
      };

      // Should not throw - fee is ignored with a warning
      const [deployed] = await noFeeWriter.create(artifact);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      // Fee should be undefined in raw artifact since protocol doesn't support it
      const rawArtifactArg = createStub.firstCall.args[0];
      expect(rawArtifactArg.config.fee).to.be.undefined;
    });

    it('should ignore fee config on update when protocol does not support fees', async () => {
      const updateStub = Sinon.stub().resolves([]);
      mockArtifactManager.createWriter.returns({
        read: Sinon.stub(),
        create: Sinon.stub(),
        update: updateStub,
      });

      const artifact: DeployedWarpArtifact = {
        ...baseDeployedArtifact,
        config: configWithFee,
      };

      // Should not throw - fee is ignored with a warning
      const updateTxs = await noFeeWriter.update(artifact);
      expect(updateTxs).to.be.an('array');
    });
  });
});
