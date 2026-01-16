import { type EncodeObject } from '@cosmjs/proto-signing';
import { type DeliverTxResponse } from '@cosmjs/stargate';
import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type HookType,
  type IgpHookConfig,
  type MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { CosmosHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { createSigner } from '../testing/utils.js';

describe('Cosmos Hooks Artifact API (e2e)', function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<EncodeObject, DeliverTxResponse>;
  let cosmosSigner: CosmosNativeSigner;
  let artifactManager: CosmosHookArtifactManager;
  let mailboxAddress: string;
  let denom: string;

  before(async () => {
    signer = await createSigner('alice');
    cosmosSigner = signer as CosmosNativeSigner;

    // Setup: Create a mailbox for hook tests
    const { ismAddress } = await signer.createNoopIsm({});
    const domainId = 1234;
    const mailboxResult = await signer.createMailbox({
      domainId,
      defaultIsmAddress: ismAddress,
    });
    mailboxAddress = mailboxResult.mailboxAddress;
    denom = 'uhyp';

    // Create artifact manager
    artifactManager = new CosmosHookArtifactManager(
      cosmosSigner.getRpcUrls(),
      mailboxAddress,
      denom,
    );
  });

  describe('Immutable Hooks', () => {
    const testCases: Array<{
      name: string;
      type: HookType;
      config: MerkleTreeHookConfig;
    }> = [
      {
        name: 'MerkleTree Hook',
        type: AltVM.HookType.MERKLE_TREE,
        config: { type: AltVM.HookType.MERKLE_TREE },
      },
    ];

    testCases.forEach(({ name, type, config }) => {
      describe(name, () => {
        it(`should create a ${type}`, async () => {
          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [result, receipts] = await writer.create({ config });

          expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(result.config.type).to.equal(type);
          expect(result.deployed.address).to.be.a('string').and.not.be.empty;
          expect(receipts).to.be.an('array').with.length.greaterThan(0);
          receipts.forEach((receipt) => {
            expect(receipt.code).to.equal(0);
          });
        });

        it(`should read a ${type}`, async () => {
          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [deployedHook] = await writer.create({ config });

          const reader = artifactManager.createReader(type);
          const readHook = await reader.read(deployedHook.deployed.address);

          expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
          expect(readHook.config.type).to.equal(type);
          expect(readHook.deployed.address).to.equal(
            deployedHook.deployed.address,
          );
        });

        it('should return no transactions when calling update', async () => {
          const writer = artifactManager.createWriter(type, cosmosSigner);
          const [deployedHook] = await writer.create({ config });

          const txs = await writer.update(deployedHook);
          expect(txs).to.be.an('array').with.length(0);
        });
      });
    });
  });

  describe(AltVM.HookType.INTERCHAIN_GAS_PAYMASTER, () => {
    const baseConfig: IgpHookConfig = {
      type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: '',
      beneficiary: '',
      oracleKey: '',
      overhead: {
        '1234': 50000,
      },
      oracleConfig: {
        '1234': {
          gasPrice: '100',
          tokenExchangeRate: '1000000000000000000',
        },
      },
    };

    let igpWriter: ArtifactWriter<IgpHookConfig, DeployedHookAddress>;

    before(() => {
      const signerAddress = cosmosSigner.getSignerAddress();
      baseConfig.owner = signerAddress;
      baseConfig.beneficiary = signerAddress;
      baseConfig.oracleKey = signerAddress;

      igpWriter = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        cosmosSigner,
      );
    });

    it('should create and read the provided config', async () => {
      const [igpHook, receipts] = await igpWriter.create({
        config: baseConfig,
      });

      expect(igpHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(igpHook.config.type).to.equal(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(igpHook.deployed.address).to.be.a('string').and.not.be.empty;
      expect(receipts.length).to.be.greaterThan(1); // Create + gas configs
      receipts.forEach((receipt) => {
        expect(receipt.code).to.equal(0);
      });

      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const readHook = await reader.read(igpHook.deployed.address);

      expect(readHook.config.type).to.equal(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(readHook.config.owner).to.equal(baseConfig.owner);
      expect(readHook.config.overhead['1234']).to.equal(50000);
      expect(readHook.config.oracleConfig['1234'].gasPrice).to.equal('100');
      expect(readHook.config.oracleConfig['1234'].tokenExchangeRate).to.equal(
        '1000000000000000000',
      );
    });

    it('should update the owner', async () => {
      const [igpHook] = await igpWriter.create({ config: baseConfig });

      const bobSigner = await createSigner('bob');
      const newOwner = bobSigner.getSignerAddress();

      const updatedConfig: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        ...igpHook,
        config: {
          ...igpHook.config,
          owner: newOwner,
        },
      };

      const txs = await igpWriter.update(updatedConfig);

      expect(txs).to.be.an('array').with.length(1);
      expect(txs[0].typeUrl).to.include('MsgSetIgpOwner');
    });

    it('should add a new destination gas config', async () => {
      const [igpHook] = await igpWriter.create({ config: baseConfig });

      const DOMAIN_2 = 5678;
      const updatedConfig: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        ...igpHook,
        config: {
          ...igpHook.config,
          overhead: {
            ...igpHook.config.overhead,
            [DOMAIN_2]: 70000,
          },
          oracleConfig: {
            ...igpHook.config.oracleConfig,
            [DOMAIN_2]: {
              gasPrice: '150',
              tokenExchangeRate: '1500000000000000000',
            },
          },
        },
      };

      const txs = await igpWriter.update(updatedConfig);

      expect(txs).to.be.an('array').with.length(1);
      expect(txs[0].typeUrl).to.include('MsgSetDestinationGasConfig');
    });

    it('should update an existing destination gas config', async () => {
      const [igpHook] = await igpWriter.create({ config: baseConfig });

      const DOMAIN_1 = 1234;
      const updatedConfig: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        ...igpHook,
        config: {
          ...igpHook.config,
          overhead: {
            [DOMAIN_1]: 60000, // Updated from 50000
          },
          oracleConfig: {
            [DOMAIN_1]: {
              gasPrice: '200', // Updated from 100
              tokenExchangeRate: '2000000000000000000', // Updated
            },
          },
        },
      };

      const txs = await igpWriter.update(updatedConfig);

      expect(txs).to.be.an('array').with.length(1);
      expect(txs[0].typeUrl).to.include('MsgSetDestinationGasConfig');
    });

    it('should handle multiple updates at once', async () => {
      const [igpHook] = await igpWriter.create({ config: baseConfig });

      const bobSigner = await createSigner('bob');
      const newOwner = bobSigner.getSignerAddress();

      const DOMAIN_1 = 1234;
      const DOMAIN_2 = 5678;
      const updatedConfig: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        ...igpHook,
        config: {
          ...igpHook.config,
          owner: newOwner, // Change owner
          overhead: {
            [DOMAIN_1]: 60000, // Update existing
            [DOMAIN_2]: 70000, // Add new
          },
          oracleConfig: {
            [DOMAIN_1]: {
              gasPrice: '200',
              tokenExchangeRate: '2000000000000000000',
            },
            [DOMAIN_2]: {
              gasPrice: '150',
              tokenExchangeRate: '1500000000000000000',
            },
          },
        },
      };

      const txs = await igpWriter.update(updatedConfig);

      expect(txs).to.be.an('array').with.length(3); // 1 owner + 2 gas configs
      expect(txs[0].typeUrl).to.include('MsgSetIgpOwner');
      expect(txs[1].typeUrl).to.include('MsgSetDestinationGasConfig');
      expect(txs[2].typeUrl).to.include('MsgSetDestinationGasConfig');
    });
  });
});
