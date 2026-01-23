import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { MockProvider } from '../../test/AltVMMockProvider.js';
import { MockSigner } from '../../test/AltVMMockSigner.js';

import { HookArtifactManager } from './hook-artifact-manager.js';

describe('HookArtifactManager', () => {
  let mockProvider: MockProvider;
  let mockSigner: MockSigner;
  const mailboxAddress = 'mailbox123';
  const nativeTokenDenom = 'native';
  let manager: HookArtifactManager;

  beforeEach(() => {
    mockProvider = new MockProvider();
    mockSigner = new MockSigner();
    manager = new HookArtifactManager(
      mockProvider,
      mailboxAddress,
      nativeTokenDenom,
    );
  });

  describe('readHook', () => {
    it('reads MerkleTree hook and verifies method calls', async () => {
      const hookAddress = 'merkle-hook-addr';
      let getHookTypeCalled = false;
      let getMerkleTreeHookCalled = false;
      let capturedHookTypeArgs: any;
      let capturedMerkleTreeArgs: any;

      mockProvider.getHookType = async (req) => {
        getHookTypeCalled = true;
        capturedHookTypeArgs = req;
        return AltVM.HookType.MERKLE_TREE;
      };
      mockProvider.getMerkleTreeHook = async (req) => {
        getMerkleTreeHookCalled = true;
        capturedMerkleTreeArgs = req;
        return {
          address: hookAddress,
        };
      };

      const result = await manager.readHook(hookAddress);

      expect(getHookTypeCalled).to.be.true;
      expect(getMerkleTreeHookCalled).to.be.true;
      expect(capturedHookTypeArgs.hookAddress).to.equal(hookAddress);
      expect(capturedMerkleTreeArgs.hookAddress).to.equal(hookAddress);
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal('merkleTreeHook');
      expect(result.deployed.address).to.equal(hookAddress).and.be.a('string');
    });

    it('reads IGP hook and verifies method calls', async () => {
      const hookAddress = 'igp-hook-addr';
      let getHookTypeCalled = false;
      let getIgpHookCalled = false;
      let capturedHookTypeArgs: any;
      let capturedIgpArgs: any;

      mockProvider.getHookType = async (req) => {
        getHookTypeCalled = true;
        capturedHookTypeArgs = req;
        return AltVM.HookType.INTERCHAIN_GAS_PAYMASTER;
      };
      mockProvider.getInterchainGasPaymasterHook = async (req) => {
        getIgpHookCalled = true;
        capturedIgpArgs = req;
        return {
          address: hookAddress,
          owner: 'owner123',
          destinationGasConfigs: {
            '1': {
              gasOracle: {
                tokenExchangeRate: '1000000',
                gasPrice: '100',
              },
              gasOverhead: '50000',
            },
          },
        };
      };

      const result = await manager.readHook(hookAddress);

      expect(getHookTypeCalled).to.be.true;
      expect(getIgpHookCalled).to.be.true;
      expect(capturedHookTypeArgs.hookAddress).to.equal(hookAddress);
      expect(capturedIgpArgs.hookAddress).to.equal(hookAddress);
      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal('interchainGasPaymaster');
      expect(result.deployed.address).to.equal(hookAddress).and.be.a('string');
      // Verify IGP-specific config
      if (result.config.type === 'interchainGasPaymaster') {
        expect(result.config.owner).to.equal('owner123');
        expect(result.config.overhead).to.deep.equal({ 1: 50000 });
        expect(result.config.oracleConfig[1].gasPrice).to.equal('100');
        expect(result.config.oracleConfig[1].tokenExchangeRate).to.equal(
          '1000000',
        );
      }
    });
  });

  describe('createReader', () => {
    it('creates MerkleTree hook reader', () => {
      const reader = manager.createReader(AltVM.HookType.MERKLE_TREE);
      expect(reader).to.not.be.undefined;
    });

    it('creates IGP hook reader', () => {
      const reader = manager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(reader).to.not.be.undefined;
    });
  });

  describe('createWriter', () => {
    it('creates MerkleTree hook writer and verifies deployment', async () => {
      const hookAddress = 'deployed-merkle-hook';
      let createMerkleTreeHookCalled = false;
      let capturedCreateArgs: any;

      mockSigner.getSignerAddress = () => 'signer-address';
      mockSigner.createMerkleTreeHook = async (req) => {
        createMerkleTreeHookCalled = true;
        capturedCreateArgs = req;
        return {
          hookAddress,
          receipts: [{ txHash: 'tx123' }],
        };
      };

      const writer = manager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        mockSigner,
      );
      expect(writer).to.not.be.undefined;

      const [deployed, receipts] = await writer.create({
        artifactState: 'new' as const,
        config: { type: 'merkleTreeHook' },
      });

      expect(createMerkleTreeHookCalled).to.be.true;
      expect(capturedCreateArgs.mailboxAddress).to.equal(mailboxAddress);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('merkleTreeHook');
      expect(deployed.deployed.address)
        .to.equal(hookAddress)
        .and.be.a('string');
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('creates IGP hook writer and verifies deployment', async () => {
      const hookAddress = 'deployed-igp-hook';
      const signerAddress = 'signer-address';
      let createIgpHookCalled = false;
      let setDestinationGasConfigCalled = false;
      let capturedCreateArgs: any;
      let capturedGasConfigArgs: any;

      mockSigner.getSignerAddress = () => signerAddress;
      mockSigner.createInterchainGasPaymasterHook = async (req) => {
        createIgpHookCalled = true;
        capturedCreateArgs = req;
        return {
          hookAddress,
          receipts: [{ txHash: 'tx123' }],
        };
      };
      mockSigner.setDestinationGasConfig = async (req) => {
        setDestinationGasConfigCalled = true;
        capturedGasConfigArgs = req;
        return {
          receipts: [{ txHash: 'tx456' }],
        };
      };
      mockSigner.setInterchainGasPaymasterHookOwner = async () => {
        return {
          receipts: [{ txHash: 'tx789' }],
        };
      };

      const writer = manager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        mockSigner,
      );
      expect(writer).to.not.be.undefined;

      const [deployed, receipts] = await writer.create({
        artifactState: 'new' as const,
        config: {
          type: 'interchainGasPaymaster',
          owner: signerAddress,
          beneficiary: 'beneficiary-address',
          oracleKey: 'oracle-key',
          overhead: { 1: 50000 },
          oracleConfig: {
            1: {
              gasPrice: '100',
              tokenExchangeRate: '1000000',
            },
          },
        },
      });

      expect(createIgpHookCalled).to.be.true;
      expect(setDestinationGasConfigCalled).to.be.true;
      expect(capturedCreateArgs.mailboxAddress).to.equal(mailboxAddress);
      expect(capturedCreateArgs.denom).to.equal(nativeTokenDenom);
      expect(capturedGasConfigArgs.hookAddress).to.equal(hookAddress);
      expect(
        capturedGasConfigArgs.destinationGasConfig.remoteDomainId,
      ).to.equal(1);
      expect(capturedGasConfigArgs.destinationGasConfig.gasOverhead).to.equal(
        '50000',
      );
      expect(
        capturedGasConfigArgs.destinationGasConfig.gasOracle.gasPrice,
      ).to.equal('100');
      expect(
        capturedGasConfigArgs.destinationGasConfig.gasOracle.tokenExchangeRate,
      ).to.equal('1000000');
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config.type).to.equal('interchainGasPaymaster');
      expect(deployed.deployed.address)
        .to.equal(hookAddress)
        .and.be.a('string');
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('throws error for unsupported hook type', () => {
      expect(() =>
        manager.createWriter(
          // @ts-expect-error Testing invalid type
          'INVALID_TYPE',
          mockSigner,
        ),
      ).to.throw();
    });
  });
});
