import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { MockProvider } from '../../test/AltVMMockProvider.js';
import { MockSigner } from '../../test/AltVMMockSigner.js';

import { IsmArtifactManager } from './ism-artifact-manager.js';

describe('IsmArtifactManager', () => {
  let mockProvider: MockProvider;
  let mockSigner: MockSigner;
  let manager: IsmArtifactManager;

  beforeEach(() => {
    mockProvider = new MockProvider();
    mockSigner = new MockSigner();
    manager = new IsmArtifactManager(mockProvider);
  });

  describe('readIsm', () => {
    it('reads TEST_ISM and verifies method calls', async () => {
      const ismAddress = 'test-ism-addr';
      let getIsmTypeCalled = false;
      let getNoopIsmCalled = false;
      let capturedIsmTypeArgs: any;
      let capturedNoopArgs: any;

      mockProvider.getIsmType = async (req) => {
        getIsmTypeCalled = true;
        capturedIsmTypeArgs = req;
        return AltVM.IsmType.TEST_ISM;
      };
      mockProvider.getNoopIsm = async (req) => {
        getNoopIsmCalled = true;
        capturedNoopArgs = req;
        return {
          address: ismAddress,
        };
      };

      const result = await manager.readIsm(ismAddress);

      expect(getIsmTypeCalled).to.be.true;
      expect(getNoopIsmCalled).to.be.true;
      expect(capturedIsmTypeArgs.ismAddress).to.equal(ismAddress);
      expect(capturedNoopArgs.ismAddress).to.equal(ismAddress);
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal('testIsm');
      expect(result.deployed.address).to.equal(ismAddress).and.be.a('string');
    });

    it('reads MESSAGE_ID_MULTISIG and verifies method calls', async () => {
      const ismAddress = 'message-id-multisig-addr';
      let getIsmTypeCalled = false;
      let getMessageIdMultisigCalled = false;
      let capturedIsmTypeArgs: any;
      let capturedMultisigArgs: any;

      mockProvider.getIsmType = async (req) => {
        getIsmTypeCalled = true;
        capturedIsmTypeArgs = req;
        return AltVM.IsmType.MESSAGE_ID_MULTISIG;
      };
      mockProvider.getMessageIdMultisigIsm = async (req) => {
        getMessageIdMultisigCalled = true;
        capturedMultisigArgs = req;
        return {
          address: ismAddress,
          threshold: 2,
          validators: ['val1', 'val2', 'val3'],
        };
      };

      const result = await manager.readIsm(ismAddress);

      expect(getIsmTypeCalled).to.be.true;
      expect(getMessageIdMultisigCalled).to.be.true;
      expect(capturedIsmTypeArgs.ismAddress).to.equal(ismAddress);
      expect(capturedMultisigArgs.ismAddress).to.equal(ismAddress);
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal('messageIdMultisigIsm');
      expect(result.deployed.address).to.equal(ismAddress).and.be.a('string');
      if (result.config.type === 'messageIdMultisigIsm') {
        expect(result.config.threshold).to.equal(2);
        expect(result.config.validators).to.deep.equal([
          'val1',
          'val2',
          'val3',
        ]);
        expect(result.config.validators).to.have.length(3);
      }
    });

    it('reads MERKLE_ROOT_MULTISIG and verifies method calls', async () => {
      const ismAddress = 'merkle-root-multisig-addr';
      let getIsmTypeCalled = false;
      let getMerkleRootMultisigCalled = false;
      let capturedIsmTypeArgs: any;
      let capturedMultisigArgs: any;

      mockProvider.getIsmType = async (req) => {
        getIsmTypeCalled = true;
        capturedIsmTypeArgs = req;
        return AltVM.IsmType.MERKLE_ROOT_MULTISIG;
      };
      mockProvider.getMerkleRootMultisigIsm = async (req) => {
        getMerkleRootMultisigCalled = true;
        capturedMultisigArgs = req;
        return {
          address: ismAddress,
          threshold: 3,
          validators: ['val1', 'val2', 'val3', 'val4'],
        };
      };

      const result = await manager.readIsm(ismAddress);

      expect(getIsmTypeCalled).to.be.true;
      expect(getMerkleRootMultisigCalled).to.be.true;
      expect(capturedIsmTypeArgs.ismAddress).to.equal(ismAddress);
      expect(capturedMultisigArgs.ismAddress).to.equal(ismAddress);
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal('merkleRootMultisigIsm');
      expect(result.deployed.address).to.equal(ismAddress).and.be.a('string');
      if (result.config.type === 'merkleRootMultisigIsm') {
        expect(result.config.threshold).to.equal(3);
        expect(result.config.validators).to.have.length(4);
        expect(result.config.validators).to.deep.equal([
          'val1',
          'val2',
          'val3',
          'val4',
        ]);
      }
    });

    it('reads ROUTING and verifies method calls', async () => {
      const ismAddress = 'routing-ism-addr';
      let getIsmTypeCalled = false;
      let getRoutingIsmCalled = false;
      let capturedIsmTypeArgs: any;
      let capturedRoutingArgs: any;

      mockProvider.getIsmType = async (req) => {
        getIsmTypeCalled = true;
        capturedIsmTypeArgs = req;
        return AltVM.IsmType.ROUTING;
      };
      mockProvider.getRoutingIsm = async (req) => {
        getRoutingIsmCalled = true;
        capturedRoutingArgs = req;
        return {
          address: ismAddress,
          owner: 'owner123',
          routes: [
            { domainId: 1, ismAddress: 'ism1' },
            { domainId: 2, ismAddress: 'ism2' },
          ],
        };
      };

      const result = await manager.readIsm(ismAddress);

      expect(getIsmTypeCalled).to.be.true;
      expect(getRoutingIsmCalled).to.be.true;
      expect(capturedIsmTypeArgs.ismAddress).to.equal(ismAddress);
      expect(capturedRoutingArgs.ismAddress).to.equal(ismAddress);
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal('domainRoutingIsm');
      expect(result.deployed.address).to.equal(ismAddress).and.be.a('string');
      // Verify routing-specific config
      if (result.config.type === 'domainRoutingIsm') {
        expect(result.config.owner).to.equal('owner123');
        expect(Object.keys(result.config.domains)).to.have.length(2);
      }
    });
  });

  describe('createReader', () => {
    it('creates TEST_ISM reader', () => {
      const reader = manager.createReader(AltVM.IsmType.TEST_ISM);
      expect(reader).to.not.be.undefined;
    });

    it('creates MESSAGE_ID_MULTISIG reader', () => {
      const reader = manager.createReader(AltVM.IsmType.MESSAGE_ID_MULTISIG);
      expect(reader).to.not.be.undefined;
    });

    it('creates MERKLE_ROOT_MULTISIG reader', () => {
      const reader = manager.createReader(AltVM.IsmType.MERKLE_ROOT_MULTISIG);
      expect(reader).to.not.be.undefined;
    });

    it('creates ROUTING reader', () => {
      const reader = manager.createReader(AltVM.IsmType.ROUTING);
      expect(reader).to.not.be.undefined;
    });

    it('throws error for unsupported ISM type', () => {
      expect(() =>
        manager.createReader(
          // @ts-expect-error Testing invalid type
          'INVALID_TYPE',
        ),
      ).to.throw('Unsupported ISM type');
    });
  });

  describe('createWriter', () => {
    it('creates TEST_ISM writer and verifies deployment', async () => {
      const ismAddress = 'deployed-test-ism';
      let createNoopIsmCalled = false;

      mockSigner.createNoopIsm = async () => {
        createNoopIsmCalled = true;
        return {
          ismAddress,
          receipts: [{ txHash: 'tx123' }],
        };
      };

      const writer = manager.createWriter(AltVM.IsmType.TEST_ISM, mockSigner);
      expect(writer).to.not.be.undefined;

      const [deployed, receipts] = await writer.create({
        artifactState: 'new' as const,
        config: { type: 'testIsm' },
      });

      expect(createNoopIsmCalled).to.be.true;
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('testIsm');
      expect(deployed.deployed.address).to.equal(ismAddress).and.be.a('string');
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('creates MESSAGE_ID_MULTISIG writer and verifies deployment', async () => {
      const ismAddress = 'deployed-message-id-multisig';
      let createMessageIdMultisigCalled = false;
      let capturedArgs: any;

      mockSigner.createMessageIdMultisigIsm = async (req) => {
        createMessageIdMultisigCalled = true;
        capturedArgs = req;
        return {
          ismAddress,
          receipts: [{ txHash: 'tx123' }],
        };
      };

      const writer = manager.createWriter(
        AltVM.IsmType.MESSAGE_ID_MULTISIG,
        mockSigner,
      );
      expect(writer).to.not.be.undefined;

      const [deployed, receipts] = await writer.create({
        artifactState: 'new' as const,
        config: {
          type: 'messageIdMultisigIsm',
          threshold: 2,
          validators: ['val1', 'val2', 'val3'],
        },
      });

      expect(createMessageIdMultisigCalled).to.be.true;
      expect(capturedArgs.threshold).to.equal(2);
      expect(capturedArgs.validators).to.deep.equal(['val1', 'val2', 'val3']);
      expect(capturedArgs.validators).to.have.length(3);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('messageIdMultisigIsm');
      expect(deployed.deployed.address).to.equal(ismAddress).and.be.a('string');
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('creates MERKLE_ROOT_MULTISIG writer and verifies deployment', async () => {
      const ismAddress = 'deployed-merkle-root-multisig';
      let createMerkleRootMultisigCalled = false;
      let capturedArgs: any;

      mockSigner.createMerkleRootMultisigIsm = async (req) => {
        createMerkleRootMultisigCalled = true;
        capturedArgs = req;
        return {
          ismAddress,
          receipts: [{ txHash: 'tx123' }],
        };
      };

      const writer = manager.createWriter(
        AltVM.IsmType.MERKLE_ROOT_MULTISIG,
        mockSigner,
      );
      expect(writer).to.not.be.undefined;

      const [deployed, receipts] = await writer.create({
        artifactState: 'new' as const,
        config: {
          type: 'merkleRootMultisigIsm',
          threshold: 3,
          validators: ['val1', 'val2', 'val3', 'val4'],
        },
      });

      expect(createMerkleRootMultisigCalled).to.be.true;
      expect(capturedArgs.threshold).to.equal(3);
      expect(capturedArgs.validators).to.have.length(4);
      expect(capturedArgs.validators).to.deep.equal([
        'val1',
        'val2',
        'val3',
        'val4',
      ]);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('merkleRootMultisigIsm');
      expect(deployed.deployed.address).to.equal(ismAddress).and.be.a('string');
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('creates ROUTING writer and verifies deployment', async () => {
      const ismAddress = 'deployed-routing-ism';
      let createRoutingIsmCalled = false;
      let capturedArgs: any;

      mockSigner.createRoutingIsm = async (req) => {
        createRoutingIsmCalled = true;
        capturedArgs = req;
        return {
          ismAddress,
          receipts: [{ txHash: 'tx123' }],
        };
      };

      const writer = manager.createWriter(AltVM.IsmType.ROUTING, mockSigner);
      expect(writer).to.not.be.undefined;

      const [deployed, receipts] = await writer.create({
        artifactState: 'new' as const,
        config: {
          type: 'domainRoutingIsm',
          owner: 'owner123',
          domains: {},
        },
      });

      expect(createRoutingIsmCalled).to.be.true;
      expect(capturedArgs.routes).to.be.an('array');
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('domainRoutingIsm');
      expect(deployed.config.owner).to.equal('owner123');
      expect(deployed.deployed.address).to.equal(ismAddress).and.be.a('string');
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('throws error for unsupported ISM type', () => {
      expect(() =>
        manager.createWriter(
          // @ts-expect-error Testing invalid type
          'INVALID_TYPE',
          mockSigner,
        ),
      ).to.throw('Unsupported ISM type');
    });
  });
});
