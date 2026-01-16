import { expect } from 'chai';
import { step } from 'mocha-steps';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type IgpHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert, normalizeConfig } from '@hyperlane-xyz/utils';

import { AleoSigner } from '../clients/signer.js';
import { AleoHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { type AleoReceipt, type AleoTransaction } from '../utils/types.js';

describe('6. aleo sdk Hook artifact readers e2e tests', async function () {
  this.timeout(100_000);

  let signer: AltVM.ISigner<AleoTransaction, AleoReceipt>;
  let providerSdkSigner: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: AleoHookArtifactManager;
  let mailboxAddress: string;

  before(async () => {
    const localnetRpc = 'http://localhost:3030';
    // test private key with funds
    const privateKey =
      'APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH';

    signer = await AleoSigner.connectWithSigner([localnetRpc], privateKey, {
      metadata: {
        chainId: 1,
      },
    });

    providerSdkSigner = signer as any;

    // Create a mailbox for hook testing
    const domainId = 1234;
    const mailbox = await signer.createMailbox({
      domainId: domainId,
    });
    mailboxAddress = mailbox.mailboxAddress;

    // Access the aleoClient from the signer to create the artifact manager
    const aleoClient = (signer as any).aleoClient;
    artifactManager = new AleoHookArtifactManager(aleoClient, mailboxAddress);
  });

  describe('MerkleTree Hook', () => {
    let merkleTreeHookAddress: string;

    step('should create and read a MerkleTree Hook', async () => {
      // Create MerkleTree Hook using artifact writer
      const writer = artifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        signer as any,
      );

      const [deployedArtifact] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: AltVM.HookType.MERKLE_TREE,
        },
      });

      merkleTreeHookAddress = deployedArtifact.deployed.address;

      expect(merkleTreeHookAddress).to.be.a('string').and.not.be.empty;

      // Read using artifact manager's specific reader
      const reader = artifactManager.createReader(AltVM.HookType.MERKLE_TREE);
      const readHook = await reader.read(merkleTreeHookAddress);

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.deployed.address).to.equal(merkleTreeHookAddress);
      expect(readHook.config.type).to.equal(AltVM.HookType.MERKLE_TREE);
    });
  });

  describe('IGP Hook', () => {
    let igpHookAddress: string;

    const DOMAIN_1 = 42;
    const DOMAIN_2 = 96;

    step('should create and read an IGP Hook', async () => {
      // Create IGP Hook using artifact writer
      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        signer as any,
      );

      const [deployedArtifact] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: signer.getSignerAddress(),
          beneficiary: signer.getSignerAddress(),
          oracleKey: signer.getSignerAddress(),
          overhead: {
            [DOMAIN_1]: 50000,
            [DOMAIN_2]: 75000,
          },
          oracleConfig: {
            [DOMAIN_1]: {
              tokenExchangeRate: '1000000000000000000',
              gasPrice: '1000000000',
            },
            [DOMAIN_2]: {
              tokenExchangeRate: '2000000000000000000',
              gasPrice: '2000000000',
            },
          },
        },
      });

      igpHookAddress = deployedArtifact.deployed.address;

      expect(igpHookAddress).to.be.a('string').and.not.be.empty;

      // Read using artifact manager's specific reader
      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const readHook = await reader.read(igpHookAddress);

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.deployed.address).to.equal(igpHookAddress);
      expect(readHook.config.type).to.equal(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(readHook.config.owner).to.equal(signer.getSignerAddress());

      // Verify gas configs
      const expectedConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        oracleKey: signer.getSignerAddress(),
        overhead: {
          [DOMAIN_1]: 50000,
          [DOMAIN_2]: 75000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            tokenExchangeRate: '1000000000000000000',
            gasPrice: '1000000000',
          },
          [DOMAIN_2]: {
            tokenExchangeRate: '2000000000000000000',
            gasPrice: '2000000000',
          },
        },
      };

      expect(normalizeConfig(readHook.config)).to.deep.equal(
        normalizeConfig(expectedConfig),
      );
    });

    step('should verify IGP Hook gas config updates', async () => {
      // Update one of the gas configs using artifact writer
      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        signer as any,
      );

      // Read current config
      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const currentHook = await reader.read(igpHookAddress);

      // Update DOMAIN_1 config
      const updatedArtifact: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          ...currentHook.config,
          overhead: {
            ...currentHook.config.overhead,
            [DOMAIN_1]: 60000, // increased overhead
          },
          oracleConfig: {
            ...currentHook.config.oracleConfig,
            [DOMAIN_1]: {
              tokenExchangeRate: '1500000000000000000', // updated exchange rate
              gasPrice: '1500000000', // updated gas price
            },
          },
        },
        deployed: currentHook.deployed,
      };

      // Execute update transactions
      const transactions = await writer.update(updatedArtifact);
      for (const tx of transactions) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Read and verify update
      const readHook = await reader.read(igpHookAddress);

      expect(readHook.config.overhead[DOMAIN_1]).to.equal(60000);
      expect(readHook.config.oracleConfig[DOMAIN_1].tokenExchangeRate).to.equal(
        '1500000000000000000',
      );
      expect(readHook.config.oracleConfig[DOMAIN_1].gasPrice).to.equal(
        '1500000000',
      );

      // Verify DOMAIN_2 config unchanged
      expect(readHook.config.overhead[DOMAIN_2]).to.equal(75000);
      expect(readHook.config.oracleConfig[DOMAIN_2].tokenExchangeRate).to.equal(
        '2000000000000000000',
      );
    });

    step('should verify IGP Hook gas config removal', async () => {
      // Remove DOMAIN_2 config using artifact writer
      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        signer as any,
      );

      // Read current config
      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const currentHook = await reader.read(igpHookAddress);

      // Create updated artifact without DOMAIN_2
      const updatedArtifact: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          ...currentHook.config,
          overhead: {
            [DOMAIN_1]: currentHook.config.overhead[DOMAIN_1],
            // DOMAIN_2 omitted to remove it
          },
          oracleConfig: {
            [DOMAIN_1]: currentHook.config.oracleConfig[DOMAIN_1],
            // DOMAIN_2 omitted to remove it
          },
        },
        deployed: currentHook.deployed,
      };

      // Execute update transactions
      const transactions = await writer.update(updatedArtifact);
      for (const tx of transactions) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Read and verify removal
      const readHook = await reader.read(igpHookAddress);

      // DOMAIN_1 should still exist
      expect(readHook.config.overhead[DOMAIN_1]).to.not.be.undefined;
      expect(readHook.config.oracleConfig[DOMAIN_1]).to.not.be.undefined;

      // DOMAIN_2 should be removed
      expect(readHook.config.overhead[DOMAIN_2]).to.be.undefined;
      expect(readHook.config.oracleConfig[DOMAIN_2]).to.be.undefined;
    });

    step(
      'should transfer ownership when owner differs from deployer',
      async () => {
        // Use a different address for the new owner (not the deployer's address)
        // This is a valid Aleo address but different from the test account
        const newOwnerAddress =
          'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';

        // Create IGP hook using the artifact writer with a different owner
        const writer = artifactManager.createWriter(
          AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
          signer as any,
        );

        const [deployedArtifact] = await writer.create({
          artifactState: ArtifactState.NEW,
          config: {
            type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
            owner: newOwnerAddress,
            beneficiary: newOwnerAddress,
            oracleKey: newOwnerAddress,
            overhead: {},
            oracleConfig: {},
          },
        });

        expect(deployedArtifact.deployed.address).to.be.a('string').and.not.be
          .empty;

        // Read and verify owner was transferred
        const reader = artifactManager.createReader(
          AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        );
        const readHook = await reader.read(deployedArtifact.deployed.address);

        expect(readHook.config.owner).to.equal(newOwnerAddress);
        expect(readHook.config.owner).to.not.equal(signer.getSignerAddress());
      },
    );
  });

  describe('Generic hook reading via readHook', () => {
    const DOMAIN_1 = 42;

    step('should detect and read MerkleTree hook', async () => {
      // Create MerkleTree Hook
      const writer = artifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        signer as any,
      );

      const [deployedHook] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: AltVM.HookType.MERKLE_TREE,
        },
      });

      // Read via generic readHook (without knowing the type)
      const readHook = await artifactManager.readHook(
        deployedHook.deployed.address,
      );

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.config.type).to.equal(AltVM.HookType.MERKLE_TREE);
      expect(readHook.deployed.address).to.equal(deployedHook.deployed.address);
    });

    step('should detect and read IGP hook', async () => {
      // Create IGP Hook
      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        signer as any,
      );

      const [deployedHook] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: signer.getSignerAddress(),
          beneficiary: signer.getSignerAddress(),
          oracleKey: signer.getSignerAddress(),
          overhead: {
            [DOMAIN_1]: 50000,
          },
          oracleConfig: {
            [DOMAIN_1]: {
              tokenExchangeRate: '1000000000000000000',
              gasPrice: '1000000000',
            },
          },
        },
      });

      // Read via generic readHook (without knowing the type)
      const readHook = await artifactManager.readHook(
        deployedHook.deployed.address,
      );

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.config.type).to.equal(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(readHook.deployed.address).to.equal(deployedHook.deployed.address);

      // Verify IGP-specific config details
      // After checking the type, we can safely cast to IgpHookConfig
      const igpConfig = readHook.config;
      assert(
        igpConfig.type === HookType.INTERCHAIN_GAS_PAYMASTER,
        `Expected config to be of type ${HookType.INTERCHAIN_GAS_PAYMASTER}`,
      );
      expect(igpConfig.owner).to.equal(signer.getSignerAddress());
      expect(igpConfig.beneficiary).to.equal(signer.getSignerAddress());
      expect(igpConfig.oracleKey).to.equal(signer.getSignerAddress());
      expect(igpConfig.overhead[DOMAIN_1]).to.equal(50000);
      expect(igpConfig.oracleConfig[DOMAIN_1].gasPrice).to.equal('1000000000');
      expect(igpConfig.oracleConfig[DOMAIN_1].tokenExchangeRate).to.equal(
        '1000000000000000000',
      );
    });
  });
});
