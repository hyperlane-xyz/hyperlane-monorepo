import { expect } from 'chai';
import sinon from 'sinon';

import {
  ChainMetadataForAltVM,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import { DeployedHookArtifact } from '@hyperlane-xyz/provider-sdk/hook';
import { DeployedIsmArtifact } from '@hyperlane-xyz/provider-sdk/ism';
import {
  DeployedRawMailboxArtifact,
  IRawMailboxArtifactManager,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk/protocol';

import { CoreArtifactReader } from './core-artifact-reader.js';

// Test protocol
const TestProtocol = 'test-core-reader' as ProtocolType;

const mockProtocolProvider = {
  createProvider: sinon.stub(),
  createSigner: sinon.stub(),
  createSubmitter: sinon.stub(),
  createIsmArtifactManager: sinon.stub(),
  createHookArtifactManager: sinon.stub(),
  createMailboxArtifactManager: sinon.stub(),
  createValidatorAnnounceArtifactManager: sinon.stub(),
  getMinGas: sinon.stub(),
};

if (!hasProtocol(TestProtocol)) {
  registerProtocol(TestProtocol, () => mockProtocolProvider as any);
}

describe('CoreArtifactReader', () => {
  const mockMailboxAddress = '0xMAILBOX';
  const mockIsmAddress = '0xISM';
  const mockDefaultHookAddress = '0xDEFAULTHOOK';
  const mockRequiredHookAddress = '0xREQUIREDHOOK';
  const mockOwner = '0xOWNER';
  const mockDomainId = 1;
  const chainName = 'test-chain';

  let readMailboxStub: sinon.SinonStub<
    [string],
    Promise<DeployedRawMailboxArtifact>
  >;
  let mailboxArtifactManager: IRawMailboxArtifactManager;
  let chainLookup: ChainLookup;
  let chainMetadata: ChainMetadataForAltVM;
  let coreReader: CoreArtifactReader;

  const mockRawMailbox: DeployedRawMailboxArtifact = {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      owner: mockOwner,
      defaultIsm: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: mockIsmAddress },
      },
      defaultHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: mockDefaultHookAddress },
      },
      requiredHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: mockRequiredHookAddress },
      },
    },
    deployed: { address: mockMailboxAddress, domainId: mockDomainId },
  };

  const mockExpandedIsm: DeployedIsmArtifact = {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: 'merkleRootMultisigIsm',
      validators: ['0xVALIDATOR1'],
      threshold: 1,
    },
    deployed: { address: mockIsmAddress },
  };

  const mockExpandedDefaultHook: DeployedHookArtifact = {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: 'merkleTreeHook',
    },
    deployed: { address: mockDefaultHookAddress },
  };

  const mockExpandedRequiredHook: DeployedHookArtifact = {
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

  beforeEach(() => {
    readMailboxStub = sinon
      .stub<[string], Promise<DeployedRawMailboxArtifact>>()
      .resolves(mockRawMailbox);

    mailboxArtifactManager = {
      readMailbox: readMailboxStub,
      createReader: sinon.stub(),
      createWriter: sinon.stub(),
    } satisfies IRawMailboxArtifactManager;

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

    coreReader = new CoreArtifactReader(
      mailboxArtifactManager,
      chainMetadata,
      chainLookup,
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('read', () => {
    it('should read mailbox and expand nested ISM/hook artifacts', async () => {
      // ARRANGE
      const mockIsmReader = {
        read: sinon
          .stub<[string], Promise<DeployedIsmArtifact>>()
          .resolves(mockExpandedIsm),
      };

      const mockHookReader = {
        read: sinon
          .stub<[string], Promise<DeployedHookArtifact>>()
          .onFirstCall()
          .resolves(mockExpandedDefaultHook)
          .onSecondCall()
          .resolves(mockExpandedRequiredHook),
      };

      Object.defineProperty(coreReader, 'ismReader', {
        value: mockIsmReader,
        writable: true,
      });
      Object.defineProperty(coreReader, 'hookReader', {
        value: mockHookReader,
        writable: true,
      });

      // ACT
      const result = await coreReader.read(mockMailboxAddress);

      // ASSERT
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.owner).to.equal(mockOwner);
      expect(result.deployed.address).to.equal(mockMailboxAddress);
      expect(result.deployed.domainId).to.equal(mockDomainId);

      expect(result.config.defaultIsm).to.deep.equal(mockExpandedIsm);
      expect(result.config.defaultHook).to.deep.equal(mockExpandedDefaultHook);
      expect(result.config.requiredHook).to.deep.equal(
        mockExpandedRequiredHook,
      );

      sinon.assert.calledOnceWithExactly(readMailboxStub, mockMailboxAddress);
      sinon.assert.calledOnceWithExactly(mockIsmReader.read, mockIsmAddress);
      sinon.assert.calledWith(
        mockHookReader.read.firstCall,
        mockDefaultHookAddress,
      );
      sinon.assert.calledWith(
        mockHookReader.read.secondCall,
        mockRequiredHookAddress,
      );
    });

    it('should read ISM and hooks in parallel via Promise.all', async () => {
      // ARRANGE
      const callOrder: string[] = [];

      const mockIsmReader = {
        read: sinon
          .stub<[string], Promise<DeployedIsmArtifact>>()
          .callsFake(async () => {
            callOrder.push('ism');
            return mockExpandedIsm;
          }),
      };

      const mockHookReader = {
        read: sinon
          .stub<[string], Promise<DeployedHookArtifact>>()
          .callsFake(async (address: string) => {
            if (address === mockDefaultHookAddress) {
              callOrder.push('defaultHook');
              return mockExpandedDefaultHook;
            }
            callOrder.push('requiredHook');
            return mockExpandedRequiredHook;
          }),
      };

      Object.defineProperty(coreReader, 'ismReader', {
        value: mockIsmReader,
        writable: true,
      });
      Object.defineProperty(coreReader, 'hookReader', {
        value: mockHookReader,
        writable: true,
      });

      // ACT
      await coreReader.read(mockMailboxAddress);

      // ASSERT
      expect(callOrder).to.have.lengthOf(3);
      expect(callOrder).to.include.members([
        'ism',
        'defaultHook',
        'requiredHook',
      ]);
    });

    it('should propagate mailbox reading errors', async () => {
      // ARRANGE
      const error = new Error('Failed to read mailbox');
      readMailboxStub.rejects(error);

      // ACT & ASSERT
      await expect(coreReader.read(mockMailboxAddress)).to.be.rejectedWith(
        'Failed to read mailbox',
      );
    });

    it('should propagate ISM reader errors', async () => {
      // ARRANGE
      const error = new Error('ISM read failed');

      const mockIsmReader = {
        read: sinon
          .stub<[string], Promise<DeployedIsmArtifact>>()
          .rejects(error),
      };

      const mockHookReader = {
        read: sinon
          .stub<[string], Promise<DeployedHookArtifact>>()
          .resolves(mockExpandedDefaultHook),
      };

      Object.defineProperty(coreReader, 'ismReader', {
        value: mockIsmReader,
        writable: true,
      });
      Object.defineProperty(coreReader, 'hookReader', {
        value: mockHookReader,
        writable: true,
      });

      // ACT & ASSERT
      await expect(coreReader.read(mockMailboxAddress)).to.be.rejectedWith(
        'ISM read failed',
      );
    });

    it('should propagate hook reader errors', async () => {
      // ARRANGE
      const error = new Error('Hook read failed');

      const mockIsmReader = {
        read: sinon
          .stub<[string], Promise<DeployedIsmArtifact>>()
          .resolves(mockExpandedIsm),
      };

      const mockHookReader = {
        read: sinon
          .stub<[string], Promise<DeployedHookArtifact>>()
          .rejects(error),
      };

      Object.defineProperty(coreReader, 'ismReader', {
        value: mockIsmReader,
        writable: true,
      });
      Object.defineProperty(coreReader, 'hookReader', {
        value: mockHookReader,
        writable: true,
      });

      // ACT & ASSERT
      await expect(coreReader.read(mockMailboxAddress)).to.be.rejectedWith(
        'Hook read failed',
      );
    });
  });

  describe('deriveCoreConfig', () => {
    it('should convert artifact to DerivedCoreConfig format', async () => {
      // ARRANGE
      const mockIsmReader = {
        read: sinon
          .stub<[string], Promise<DeployedIsmArtifact>>()
          .resolves(mockExpandedIsm),
      };

      const mockHookReader = {
        read: sinon
          .stub<[string], Promise<DeployedHookArtifact>>()
          .onFirstCall()
          .resolves(mockExpandedDefaultHook)
          .onSecondCall()
          .resolves(mockExpandedRequiredHook),
      };

      Object.defineProperty(coreReader, 'ismReader', {
        value: mockIsmReader,
        writable: true,
      });
      Object.defineProperty(coreReader, 'hookReader', {
        value: mockHookReader,
        writable: true,
      });

      // ACT
      const result = await coreReader.deriveCoreConfig(mockMailboxAddress);

      // ASSERT
      expect(result.owner).to.equal(mockOwner);
      expect(result.defaultIsm).to.be.an('object');
      expect(result.defaultHook).to.be.an('object');
      expect(result.requiredHook).to.be.an('object');

      sinon.assert.calledOnce(readMailboxStub);
      sinon.assert.calledOnce(mockIsmReader.read);
      expect(mockHookReader.read.callCount).to.equal(2);
    });

    it('should propagate read errors', async () => {
      // ARRANGE
      const error = new Error('Mailbox read failed');
      readMailboxStub.rejects(error);

      // ACT & ASSERT
      await expect(
        coreReader.deriveCoreConfig(mockMailboxAddress),
      ).to.be.rejectedWith('Mailbox read failed');
    });
  });
});
