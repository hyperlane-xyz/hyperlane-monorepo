import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon from 'sinon';

import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import type {
  ArtifactNew,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import type {
  DeployedHookArtifact,
  HookArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import type {
  DeployedIsmArtifact,
  IsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk/protocol';
import {
  type CollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  type DeployedWarpArtifact,
  type RawWarpArtifactConfig,
  TokenType,
  type WarpArtifactConfig,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';

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
    } as MockArtifactManager;

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
    } as MockChainLookup;

    // Create mock ISM and Hook writers FIRST
    mockIsmWriter = {
      create: Sinon.stub<
        [ArtifactNew<IsmArtifactConfig>],
        Promise<[DeployedIsmArtifact, TxReceipt[]]>
      >(),
      update: Sinon.stub<[DeployedIsmArtifact], Promise<AnnotatedTx[]>>(),
      read: Sinon.stub(),
    } as MockIsmWriter;

    mockHookWriter = {
      create: Sinon.stub<
        [ArtifactNew<HookArtifactConfig>],
        Promise<[DeployedHookArtifact, TxReceipt[]]>
      >(),
      update: Sinon.stub<[DeployedHookArtifact], Promise<AnnotatedTx[]>>(),
      read: Sinon.stub(),
    } as MockHookWriter;

    // Create writer instance - manually to bypass protocol provider
    writer = Object.create(WarpTokenWriter.prototype);
    Object.assign(writer, {
      artifactManager: mockArtifactManager,
      chainMetadata,
      chainLookup: mockChainLookup,
      signer: mockSigner,
      ismWriter: mockIsmWriter,
      hookWriter: mockHookWriter,
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
          txs.forEach((tx) => expect(tx.annotation).to.include('router'));
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
      type: 'messageIdMultisigIsm',
      validators: string[],
    ): IsmArtifactConfig => ({
      type,
      validators,
      threshold: 1,
    });

    it('should deploy new ISM', async () => {
      const newIsmConfig = createIsmConfig('messageIdMultisigIsm', [
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

    it('should update existing ISM', async () => {
      // Setup current artifact with existing ISM
      const currentIsmConfig = createIsmConfig('messageIdMultisigIsm', [
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
        type: 'merkleRootMultisigIsm',
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
        type: 'messageIdMultisigIsm',
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
        type: 'messageIdMultisigIsm',
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
        type: 'messageIdMultisigIsm',
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

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: configWithIsm,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub(),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithIsm,
      };

      const [deployed, receipts] = await writer.create(artifact);

      expect(mockIsmWriter.create.callCount).to.equal(1);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).to.equal(TOKEN_ADDRESS);
      expect(receipts).to.be.an('array');
    });

    it('should create warp token with existing ISM', async () => {
      const existingIsmConfig: IsmArtifactConfig = {
        type: 'messageIdMultisigIsm',
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

      const mockWriter: MockRawWarpWriter = {
        read: Sinon.stub(),
        create: Sinon.stub().resolves([
          {
            artifactState: ArtifactState.DEPLOYED,
            config: configWithExistingIsm,
            deployed: { address: TOKEN_ADDRESS },
          },
          [],
        ]),
        update: Sinon.stub(),
      };

      mockArtifactManager.createWriter.returns(mockWriter);

      const artifact: ArtifactNew<WarpArtifactConfig> = {
        artifactState: ArtifactState.NEW,
        config: configWithExistingIsm,
      };

      const [deployed, receipts] = await writer.create(artifact);

      // Should not create new ISM
      expect(mockIsmWriter.create.called).to.be.false;
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).to.equal(TOKEN_ADDRESS);
      expect(receipts).to.be.an('array');
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
});
