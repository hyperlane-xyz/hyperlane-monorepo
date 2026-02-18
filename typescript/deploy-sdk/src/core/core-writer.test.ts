import { expect } from 'chai';
import sinon from 'sinon';

import {
  ChainMetadataForAltVM,
  MockSigner,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactNew,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookArtifact,
  HookArtifactConfig,
  IRawHookArtifactManager,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  DeployedIsmArtifact,
  IRawIsmArtifactManager,
  IsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  DeployedMailboxAddress,
  DeployedMailboxArtifact,
  DeployedRawMailboxArtifact,
  IRawMailboxArtifactManager,
  MailboxConfig,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk/protocol';
import {
  DeployedValidatorAnnounceArtifact,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceConfig,
} from '@hyperlane-xyz/provider-sdk/validator-announce';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import { CoreWriter } from './core-writer.js';

// Test protocol
const TestProtocol = 'test-core-writer' as ProtocolType;

let mockIsmArtifactManager: IRawIsmArtifactManager;

const mockHookArtifactManager = {
  readHook: sinon.stub(),
  createReader: sinon.stub().returns({ read: sinon.stub() }),
  createWriter: sinon.stub().returns({
    create: sinon.stub(),
    update: sinon.stub(),
    read: sinon.stub(),
  }),
} satisfies IRawHookArtifactManager;

const mockProtocolProvider = {
  createProvider: sinon.stub(),
  createSigner: sinon.stub(),
  createSubmitter: sinon.stub(),
  createIsmArtifactManager: sinon.stub(),
  createHookArtifactManager: sinon.stub().returns(mockHookArtifactManager),
  createMailboxArtifactManager: sinon.stub(),
  createValidatorAnnounceArtifactManager: sinon.stub(),
  getMinGas: sinon.stub(),
};

if (!hasProtocol(TestProtocol)) {
  registerProtocol(TestProtocol, () => mockProtocolProvider as any);
}

describe('CoreWriter', () => {
  const mockMailboxAddress = '0xMAILBOX';
  const mockIsmAddress = '0xISM';
  const mockNewIsmAddress = '0xNEWISM';
  const mockDefaultHookAddress = '0xDEFAULTHOOK';
  const mockRequiredHookAddress = '0xREQUIREDHOOK';
  const mockValidatorAnnounceAddress = '0xVA';
  const mockOwner = '0xOWNER';
  const mockSignerAddress = '0xSIGNER';
  const mockDomainId = 1;
  const chainName = 'test-chain';

  let createMailboxWriterStub: sinon.SinonStub;
  let createVAWriterStub: sinon.SinonStub;
  let getSignerAddressStub: sinon.SinonStub<[], string>;
  let sendAndConfirmTxStub: sinon.SinonStub<[AnnotatedTx], Promise<TxReceipt>>;

  let mailboxArtifactManager: IRawMailboxArtifactManager;
  let validatorAnnounceArtifactManager: IRawValidatorAnnounceArtifactManager;
  let signer: MockSigner;
  let chainLookup: ChainLookup;
  let chainMetadata: ChainMetadataForAltVM;
  let coreWriter: CoreWriter;

  const mockReceipt: TxReceipt = {
    transactionHash: '0xHASH',
    blockNumber: 123,
  };

  const mockIsm: DeployedIsmArtifact = {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: 'merkleRootMultisigIsm',
      validators: ['0xVALIDATOR1'],
      threshold: 1,
    },
    deployed: { address: mockIsmAddress },
  };

  const mockDefaultHook: DeployedHookArtifact = {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: 'merkleTreeHook',
    },
    deployed: { address: mockDefaultHookAddress },
  };

  const mockRequiredHook: DeployedHookArtifact = {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: 'interchainGasPaymaster',
      owner: mockOwner,
      beneficiary: '0xBENEFICIARY',
      oracleKey: '0xORACLE',
      overhead: {},
      oracleConfig: {},
    },
    deployed: { address: mockRequiredHookAddress },
  };

  beforeEach(async () => {
    mockIsmArtifactManager = {
      readIsm: sinon.stub(),
      createReader: sinon.stub().returns({ read: sinon.stub() }),
      createWriter: sinon.stub().returns({
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      }),
    } satisfies IRawIsmArtifactManager;

    mockProtocolProvider.createIsmArtifactManager = sinon
      .stub()
      .returns(mockIsmArtifactManager);

    signer = await MockSigner.connectWithSigner();

    getSignerAddressStub = sinon.stub<[], string>().returns(mockSignerAddress);
    sinon.stub(signer, 'getSignerAddress').callsFake(getSignerAddressStub);

    sendAndConfirmTxStub = sinon
      .stub<[AnnotatedTx], Promise<TxReceipt>>()
      .resolves(mockReceipt);
    sinon
      .stub(signer, 'sendAndConfirmTransaction')
      .callsFake(sendAndConfirmTxStub);

    const mailboxCreateStub = sinon
      .stub<
        [ArtifactNew<MailboxOnChain>],
        Promise<[DeployedRawMailboxArtifact, TxReceipt[]]>
      >()
      .resolves([
        {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            owner: mockSignerAddress,
            defaultIsm: {
              artifactState: ArtifactState.DEPLOYED,
              config: mockIsm.config,
              deployed: mockIsm.deployed,
            },
            defaultHook: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: ZERO_ADDRESS_HEX_32 },
            },
            requiredHook: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: ZERO_ADDRESS_HEX_32 },
            },
          },
          deployed: { address: mockMailboxAddress, domainId: mockDomainId },
        },
        [mockReceipt],
      ]);

    const mailboxUpdateStub = sinon
      .stub<[DeployedMailboxArtifact], Promise<AnnotatedTx[]>>()
      .resolves([]);

    const mockMailboxWriter = {
      create: mailboxCreateStub,
      update: mailboxUpdateStub,
      read: sinon.stub(),
    } satisfies ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>;

    createMailboxWriterStub = sinon.stub().returns(mockMailboxWriter);

    mailboxArtifactManager = {
      readMailbox: sinon.stub(),
      createReader: sinon.stub(),
      createWriter: createMailboxWriterStub,
    } satisfies IRawMailboxArtifactManager;

    const vaCreateStub = sinon
      .stub<
        [ArtifactNew<RawValidatorAnnounceConfig>],
        Promise<[DeployedValidatorAnnounceArtifact, TxReceipt[]]>
      >()
      .resolves([
        {
          artifactState: ArtifactState.DEPLOYED,
          config: { mailboxAddress: mockMailboxAddress },
          deployed: { address: mockValidatorAnnounceAddress },
        },
        [mockReceipt],
      ]);

    const mockVAWriter = {
      create: vaCreateStub,
      update: sinon.stub(),
      read: sinon.stub(),
    };

    createVAWriterStub = sinon.stub().returns(mockVAWriter);

    validatorAnnounceArtifactManager = {
      readValidatorAnnounce: sinon.stub(),
      createReader: sinon.stub(),
      createWriter: createVAWriterStub,
    } satisfies IRawValidatorAnnounceArtifactManager;

    chainMetadata = {
      name: chainName,
      domainId: mockDomainId,
      protocol: TestProtocol,
      chainId: mockDomainId,
    } satisfies ChainMetadataForAltVM;

    chainLookup = {
      getChainMetadata: sinon
        .stub<[string | number], ChainMetadataForAltVM>()
        .returns(chainMetadata),
      getChainName: sinon.stub<[number], string>().returns(chainName),
      getDomainId: sinon
        .stub<[string | number], number>()
        .returns(mockDomainId),
      getKnownChainNames: sinon.stub<[], string[]>().returns([chainName]),
    } satisfies ChainLookup;

    coreWriter = new CoreWriter(
      mailboxArtifactManager,
      validatorAnnounceArtifactManager,
      chainMetadata,
      chainLookup,
      signer,
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('create', () => {
    it('should deploy mailbox with NEW ISM and NEW hooks', async () => {
      // ARRANGE
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: {
            artifactState: ArtifactState.NEW,
            config: mockIsm.config,
          },
          defaultHook: {
            artifactState: ArtifactState.NEW,
            config: mockDefaultHook.config,
          },
          requiredHook: {
            artifactState: ArtifactState.NEW,
            config: mockRequiredHook.config,
          },
        },
      };

      const ismCreateStub = sinon
        .stub<
          [ArtifactNew<IsmArtifactConfig>],
          Promise<[DeployedIsmArtifact, TxReceipt[]]>
        >()
        .callsFake(async () => [mockIsm, [mockReceipt]]);

      const mockIsmWriter = {
        create: ismCreateStub,
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      const hookCreateStub = sinon
        .stub<
          [ArtifactNew<HookArtifactConfig>],
          Promise<[DeployedHookArtifact, TxReceipt[]]>
        >()
        .onFirstCall()
        .callsFake(async () => [mockDefaultHook, [mockReceipt]])
        .onSecondCall()
        .callsFake(async () => [mockRequiredHook, [mockReceipt]]);

      const mockHookWriter = {
        create: hookCreateStub,
        update: sinon.stub(),
        read: sinon.stub(),
      };

      mockHookArtifactManager.createWriter = sinon
        .stub()
        .returns(mockHookWriter);

      // ACT
      const result = await coreWriter.create(artifact);

      // ASSERT
      expect(result.mailbox.deployed.address).to.equal(mockMailboxAddress);
      expect(result.mailbox.config.owner).to.equal(mockOwner);
      expect(result.validatorAnnounce).to.not.be.null;
      expect(result.validatorAnnounce?.deployed.address).to.equal(
        mockValidatorAnnounceAddress,
      );
      expect(result.receipts.length).to.be.greaterThan(0);

      sinon.assert.calledOnce(ismCreateStub);
      sinon.assert.calledTwice(hookCreateStub);
      sinon.assert.calledWith(createMailboxWriterStub, 'mailbox', signer);
      sinon.assert.calledWith(createVAWriterStub, 'validatorAnnounce', signer);
    });

    it('should use existing ISM when DEPLOYED', async () => {
      // ARRANGE
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const ismCreateStub = sinon.stub();
      const mockIsmWriter = {
        create: ismCreateStub,
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT
      await coreWriter.create(artifact);

      // ASSERT
      sinon.assert.notCalled(ismCreateStub);
    });

    it('should handle protocol without validator announce support', async () => {
      // ARRANGE
      const coreWriterNoVA = new CoreWriter(
        mailboxArtifactManager,
        null,
        chainMetadata,
        chainLookup,
        signer,
      );

      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriterNoVA, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT
      const result = await coreWriterNoVA.create(artifact);

      // ASSERT
      expect(result.validatorAnnounce).to.be.null;
    });

    it('should create mailbox with signer as initial owner', async () => {
      // ARRANGE
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT
      await coreWriter.create(artifact);

      // ASSERT
      const mailboxWriter = createMailboxWriterStub.returnValues[0];
      const mailboxCreateStub = mailboxWriter.create;
      const initialConfig = mailboxCreateStub.firstCall.args[0].config;

      expect(initialConfig.owner).to.equal(mockSignerAddress);
      expect(initialConfig.owner).to.not.equal(mockOwner);
    });

    it('should create mailbox with zero-address hooks initially', async () => {
      // ARRANGE
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: {
            artifactState: ArtifactState.NEW,
            config: mockDefaultHook.config,
          },
          requiredHook: {
            artifactState: ArtifactState.NEW,
            config: mockRequiredHook.config,
          },
        },
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      const mockHookWriter = {
        create: sinon
          .stub()
          .onFirstCall()
          .callsFake(async () => [mockDefaultHook, [mockReceipt]])
          .onSecondCall()
          .callsFake(async () => [mockRequiredHook, [mockReceipt]]),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      mockHookArtifactManager.createWriter = sinon
        .stub()
        .returns(mockHookWriter);

      // ACT
      await coreWriter.create(artifact);

      // ASSERT
      const mailboxWriter = createMailboxWriterStub.returnValues[0];
      const mailboxCreateStub = mailboxWriter.create;
      const initialConfig = mailboxCreateStub.firstCall.args[0].config;

      expect(initialConfig.defaultHook.deployed.address).to.equal(
        ZERO_ADDRESS_HEX_32,
      );
      expect(initialConfig.requiredHook.deployed.address).to.equal(
        ZERO_ADDRESS_HEX_32,
      );
      expect(initialConfig.defaultHook.artifactState).to.equal(
        ArtifactState.UNDERIVED,
      );
    });

    it('should update mailbox with hooks and owner after deployment', async () => {
      // ARRANGE
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT
      await coreWriter.create(artifact);

      // ASSERT
      const mailboxWriter = createMailboxWriterStub.returnValues[0];
      const mailboxUpdateStub = mailboxWriter.update;

      sinon.assert.calledOnce(mailboxUpdateStub);

      const updatedArtifact = mailboxUpdateStub.firstCall.args[0];

      expect(updatedArtifact.config.owner).to.equal(mockOwner);
      expect(updatedArtifact.config.defaultHook.deployed.address).to.equal(
        mockDefaultHookAddress,
      );
      expect(updatedArtifact.config.requiredHook.deployed.address).to.equal(
        mockRequiredHookAddress,
      );
    });

    it('should execute update transactions via signer', async () => {
      // ARRANGE
      const mockUpdateTx: AnnotatedTx = {
        to: mockMailboxAddress,
        data: '0xUPDATE',
        annotation: 'Update hooks',
      };

      const mailboxCreateStub = sinon.stub().resolves([
        {
          artifactState: ArtifactState.DEPLOYED,
          config: {
            owner: mockSignerAddress,
            defaultIsm: {
              artifactState: ArtifactState.DEPLOYED,
              config: mockIsm.config,
              deployed: mockIsm.deployed,
            },
            defaultHook: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: ZERO_ADDRESS_HEX_32 },
            },
            requiredHook: {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: ZERO_ADDRESS_HEX_32 },
            },
          },
          deployed: { address: mockMailboxAddress, domainId: mockDomainId },
        },
        [mockReceipt],
      ]);

      const mailboxUpdateStub = sinon.stub().resolves([mockUpdateTx]);

      const mockMailboxWriter = {
        create: mailboxCreateStub,
        update: mailboxUpdateStub,
        read: sinon.stub(),
      };

      mailboxArtifactManager.createWriter = sinon
        .stub()
        .returns(mockMailboxWriter);

      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT
      await coreWriter.create(artifact);

      // ASSERT
      sinon.assert.calledWith(sendAndConfirmTxStub, mockUpdateTx);
    });

    it('should collect receipts from all steps', async () => {
      // ARRANGE
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: {
            artifactState: ArtifactState.NEW,
            config: mockIsm.config,
          },
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon
          .stub()
          .callsFake(async () => [mockIsm, [mockReceipt, mockReceipt]]),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT
      const result = await coreWriter.create(artifact);

      // ASSERT
      expect(result.receipts.length).to.be.greaterThan(0);
      expect(result.receipts.length).to.be.at.least(4);
    });

    it('should propagate ISM deployment errors', async () => {
      // ARRANGE
      const error = new Error('ISM deployment failed');
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: {
            artifactState: ArtifactState.NEW,
            config: mockIsm.config,
          },
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub().rejects(error),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT & ASSERT
      await expect(coreWriter.create(artifact)).to.be.rejectedWith(
        'ISM deployment failed',
      );
    });

    it('should propagate mailbox creation errors', async () => {
      // ARRANGE
      const error = new Error('Mailbox creation failed');
      const mockMailboxWriter = {
        create: sinon.stub().rejects(error),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      mailboxArtifactManager.createWriter = sinon
        .stub()
        .returns(mockMailboxWriter);

      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT & ASSERT
      await expect(coreWriter.create(artifact)).to.be.rejectedWith(
        'Mailbox creation failed',
      );
    });
  });

  describe('update', () => {
    it('should handle ISM type change by deploying new ISM', async () => {
      // ARRANGE
      const currentMailbox: DeployedMailboxArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
        deployed: { address: mockMailboxAddress, domainId: mockDomainId },
      };

      sinon.stub(coreWriter, 'read').resolves(currentMailbox);

      const newIsm: DeployedIsmArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'messageIdMultisigIsm',
          validators: ['0xVALIDATOR2'],
          threshold: 1,
        },
        deployed: { address: mockNewIsmAddress },
      };

      const expectedArtifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: {
            artifactState: ArtifactState.NEW,
            config: newIsm.config,
          },
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const ismCreateStub = sinon
        .stub<
          [ArtifactNew<IsmArtifactConfig>],
          Promise<[DeployedIsmArtifact, TxReceipt[]]>
        >()
        .callsFake(async () => [newIsm, [mockReceipt]]);

      const mockIsmWriter = {
        create: ismCreateStub,
        update: sinon.stub(),
        read: sinon.stub(),
      };

      mockIsmArtifactManager.createWriter = sinon.stub().returns(mockIsmWriter);

      const mockHookWriter = {
        create: sinon.stub(),
        update: sinon.stub().resolves([]),
        read: sinon.stub(),
      };

      mockHookArtifactManager.createWriter = sinon
        .stub()
        .returns(mockHookWriter);

      // ACT
      await coreWriter.update(mockMailboxAddress, expectedArtifact);

      // ASSERT
      sinon.assert.calledOnce(ismCreateStub);
      const createArg = ismCreateStub.firstCall.args[0];
      expect(createArg.artifactState).to.equal(ArtifactState.NEW);
      expect(createArg.config.type).to.equal('messageIdMultisigIsm');
    });

    it('should handle UNDERIVED ISM by using address as-is', async () => {
      // ARRANGE
      const currentMailbox: DeployedMailboxArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
        deployed: { address: mockMailboxAddress, domainId: mockDomainId },
      };

      sinon.stub(coreWriter, 'read').resolves(currentMailbox);

      const expectedArtifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: mockIsmAddress },
          },
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const ismCreateStub = sinon.stub();
      const ismUpdateStub = sinon.stub();

      const mockIsmWriter = {
        create: ismCreateStub,
        update: ismUpdateStub,
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      const mockHookWriter = {
        create: sinon.stub(),
        update: sinon.stub().resolves([]),
        read: sinon.stub(),
      };

      mockHookArtifactManager.createWriter = sinon
        .stub()
        .returns(mockHookWriter);

      // ACT
      await coreWriter.update(mockMailboxAddress, expectedArtifact);

      // ASSERT
      sinon.assert.notCalled(ismCreateStub);
      sinon.assert.notCalled(ismUpdateStub);
    });

    it('should return empty array when no updates needed', async () => {
      // ARRANGE
      const currentMailbox: DeployedMailboxArtifact = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
        deployed: { address: mockMailboxAddress, domainId: mockDomainId },
      };

      sinon.stub(coreWriter, 'read').resolves(currentMailbox);

      const expectedArtifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: currentMailbox.config,
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub().resolves([]),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      const mockHookWriter = {
        create: sinon.stub(),
        update: sinon.stub().resolves([]),
        read: sinon.stub(),
      };

      mockHookArtifactManager.createWriter = sinon
        .stub()
        .returns(mockHookWriter);

      // ACT
      const result = await coreWriter.update(
        mockMailboxAddress,
        expectedArtifact,
      );

      // ASSERT
      expect(result).to.be.an('array').with.lengthOf(0);
    });

    it('should assert artifacts are expanded before updating', async () => {
      // ARRANGE
      const currentMailbox = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          owner: mockOwner,
          defaultIsm: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: mockIsmAddress },
          },
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
        deployed: { address: mockMailboxAddress, domainId: mockDomainId },
      };

      sinon.stub(coreWriter, 'read').resolves(currentMailbox as any);

      const expectedArtifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      // ACT & ASSERT
      await expect(
        coreWriter.update(mockMailboxAddress, expectedArtifact),
      ).to.be.rejectedWith('Expected Core Reader to expand the ISM config');
    });

    it('should propagate ISM deployment errors', async () => {
      // ARRANGE
      const error = new Error('ISM deployment failed');
      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: {
            artifactState: ArtifactState.NEW,
            config: mockIsm.config,
          },
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub().rejects(error),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT & ASSERT
      await expect(coreWriter.create(artifact)).to.be.rejectedWith(
        'ISM deployment failed',
      );
    });

    it('should propagate mailbox creation errors', async () => {
      // ARRANGE
      const error = new Error('Mailbox creation failed');
      const mockMailboxWriter = {
        create: sinon.stub().rejects(error),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      mailboxArtifactManager.createWriter = sinon
        .stub()
        .returns(mockMailboxWriter);

      const artifact: ArtifactNew<MailboxConfig> = {
        artifactState: ArtifactState.NEW,
        config: {
          owner: mockOwner,
          defaultIsm: mockIsm,
          defaultHook: mockDefaultHook,
          requiredHook: mockRequiredHook,
        },
      };

      const mockIsmWriter = {
        create: sinon.stub(),
        update: sinon.stub(),
        read: sinon.stub(),
      };

      Object.defineProperty(coreWriter, 'ismWriter', {
        value: mockIsmWriter,
        writable: true,
      });

      // ACT & ASSERT
      await expect(coreWriter.create(artifact)).to.be.rejectedWith(
        'Mailbox creation failed',
      );
    });
  });
});
