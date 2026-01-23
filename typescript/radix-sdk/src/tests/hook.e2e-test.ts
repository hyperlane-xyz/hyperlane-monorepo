import { expect } from 'chai';

import { AltVM, HookArtifactManager } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedHookAddress,
  IgpHookConfig,
  MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { assert, eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixProvider } from '../clients/provider.js';
import { RadixSigner } from '../clients/signer.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_RADIX_BURN_ADDRESS,
  TEST_RADIX_DEPLOYER_ADDRESS,
  TEST_RADIX_PRIVATE_KEY,
} from '../testing/constants.js';

import { DEPLOYED_TEST_CHAIN_METADATA } from './e2e-test.setup.js';

describe('Radix Hooks (e2e)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let radixProvider: RadixProvider;
  let radixSigner: RadixSigner;
  let providerSdkSigner: ISigner<AnnotatedTx, TxReceipt>;
  let artifactManager: HookArtifactManager;

  const DOMAIN_1 = 42;
  const DOMAIN_2 = 96;

  before(async () => {
    const rpcUrls =
      DEPLOYED_TEST_CHAIN_METADATA.rpcUrls?.map((url) => url.http) ?? [];
    assert(rpcUrls.length > 0, 'Expected at least 1 rpc url for the tests');

    radixProvider = await RadixProvider.connect(
      rpcUrls,
      DEPLOYED_TEST_CHAIN_METADATA.chainId,
    );

    radixSigner = (await RadixSigner.connectWithSigner(
      rpcUrls,
      TEST_RADIX_PRIVATE_KEY,
      {
        metadata: {
          chainId: DEPLOYED_TEST_CHAIN_METADATA.chainId,
          gatewayUrls: DEPLOYED_TEST_CHAIN_METADATA.gatewayUrls,
          packageAddress: DEPLOYED_TEST_CHAIN_METADATA.packageAddress,
        },
      },
    )) as RadixSigner;

    providerSdkSigner = radixSigner;

    const nativeTokenDenom =
      DEPLOYED_TEST_CHAIN_METADATA.nativeToken?.denom ?? 'xrd';
    // Use deployer address as mailbox for testing purposes
    const mailboxAddress = TEST_RADIX_DEPLOYER_ADDRESS;
    artifactManager = new HookArtifactManager(
      radixProvider,
      mailboxAddress,
      nativeTokenDenom,
    );
  });

  describe('MerkleTree Hook', () => {
    it('should create a MerkleTree hook', async () => {
      const config: MerkleTreeHookConfig = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        radixSigner,
      );
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal(AltVM.HookType.MERKLE_TREE);
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('should read a MerkleTree hook', async () => {
      const config: MerkleTreeHookConfig = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config });

      const reader = artifactManager.createReader(AltVM.HookType.MERKLE_TREE);
      const readHook = await reader.read(deployedHook.deployed.address);

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.config.type).to.equal(AltVM.HookType.MERKLE_TREE);
      expect(readHook.deployed.address).to.equal(deployedHook.deployed.address);
    });

    it('should return no transactions when calling update on MerkleTree hook', async () => {
      const config: MerkleTreeHookConfig = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config });

      // MerkleTree hooks are immutable
      const txs = await writer.update(deployedHook);
      expect(txs).to.be.an('array').with.length(0);
    });
  });

  describe('IGP Hook', () => {
    it('should create an IGP hook', async () => {
      const config: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
          [DOMAIN_2]: 100000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
          [DOMAIN_2]: {
            gasPrice: '2000000000',
            tokenExchangeRate: '15000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.type).to.equal(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      expect(receipts).to.be.an('array').with.length.greaterThan(0);
    });

    it('should read an IGP hook', async () => {
      const config: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config });

      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const readHook = await reader.read(deployedHook.deployed.address);

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.config.type).to.equal(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(readHook.deployed.address).to.equal(deployedHook.deployed.address);

      // Verify config matches (excluding beneficiary/oracleKey which are placeholders)
      expect(readHook.config.owner).to.equal(config.owner);
      expect(readHook.config.overhead).to.deep.equal(config.overhead);

      // Verify oracle config (note: tokenDecimals is not stored on-chain for Radix)
      expect(readHook.config.oracleConfig[DOMAIN_1].gasPrice).to.equal(
        config.oracleConfig[DOMAIN_1].gasPrice,
      );
      expect(readHook.config.oracleConfig[DOMAIN_1].tokenExchangeRate).to.equal(
        config.oracleConfig[DOMAIN_1].tokenExchangeRate,
      );
    });

    it('should create IGP hook with specified owner different from signer', async () => {
      const config: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_BURN_ADDRESS, // Different from signer
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config });

      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const readHook = await reader.read(deployedHook.deployed.address);

      // Verify ownership was transferred
      expect(eqAddressRadix(readHook.config.owner, TEST_RADIX_BURN_ADDRESS)).to
        .be.true;
    });

    it('should update IGP hook gas configs', async () => {
      const initialConfig: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config: initialConfig });

      // Update with new gas config
      const updatedConfig: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        ...deployedHook,
        config: {
          ...deployedHook.config,
          overhead: {
            [DOMAIN_1]: 60000, // Changed
            [DOMAIN_2]: 100000, // New domain
          },
          oracleConfig: {
            [DOMAIN_1]: {
              gasPrice: '2000000000', // Changed
              tokenExchangeRate: '12000000000', // Changed
            },
            [DOMAIN_2]: {
              gasPrice: '3000000000',
              tokenExchangeRate: '15000000000',
            },
          },
        },
      };

      const txs = await writer.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      // Execute the update transactions
      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Verify the updates
      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const readHook = await reader.read(deployedHook.deployed.address);

      expect(readHook.config.overhead[DOMAIN_1]).to.equal(60000);
      expect(readHook.config.overhead[DOMAIN_2]).to.equal(100000);
      expect(readHook.config.oracleConfig[DOMAIN_1].gasPrice).to.equal(
        '2000000000',
      );
      expect(readHook.config.oracleConfig[DOMAIN_2].gasPrice).to.equal(
        '3000000000',
      );
    });

    it('should transfer ownership of IGP hook via update', async () => {
      const initialConfig: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config: initialConfig });

      // Update ownership
      const updatedConfig: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        ...deployedHook,
        config: {
          ...deployedHook.config,
          owner: TEST_RADIX_BURN_ADDRESS,
        },
      };

      const txs = await writer.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      // Execute the update transactions
      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Verify ownership transfer
      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const readHook = await reader.read(deployedHook.deployed.address);

      expect(eqAddressRadix(readHook.config.owner, TEST_RADIX_BURN_ADDRESS)).to
        .be.true;
    });

    it('should return no update transactions when config is unchanged', async () => {
      const config: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config });

      // Try to update with same config
      const txs = await writer.update(deployedHook);
      expect(txs).to.be.an('array').with.length(0);
    });

    it('should update gas configs AND transfer ownership (ownership last)', async () => {
      // This test exposes the bug where ownership transfer happens before gas config updates
      // The ownership transfer MUST be the last transaction, otherwise the gas config
      // updates will fail because the signer is no longer the owner
      const initialConfig: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config: initialConfig });

      // Update BOTH gas config AND ownership
      const updatedConfig: ArtifactDeployed<
        IgpHookConfig,
        DeployedHookAddress
      > = {
        ...deployedHook,
        config: {
          ...deployedHook.config,
          owner: TEST_RADIX_BURN_ADDRESS, // Transfer ownership
          overhead: {
            [DOMAIN_1]: 60000, // Also update gas config
            [DOMAIN_2]: 100000, // Add new domain
          },
          oracleConfig: {
            [DOMAIN_1]: {
              gasPrice: '2000000000', // Changed
              tokenExchangeRate: '12000000000', // Changed
            },
            [DOMAIN_2]: {
              gasPrice: '3000000000',
              tokenExchangeRate: '15000000000',
            },
          },
        },
      };

      const txs = await writer.update(updatedConfig);
      expect(txs).to.be.an('array').with.length.greaterThan(0);

      // Verify ownership transfer is the LAST transaction
      const lastTx = txs[txs.length - 1];
      expect(lastTx.annotation).to.include('owner');

      // Execute all transactions - this will fail if ownership transfer is not last
      for (const tx of txs) {
        await providerSdkSigner.sendAndConfirmTransaction(tx);
      }

      // Verify both gas config updates AND ownership transfer succeeded
      const reader = artifactManager.createReader(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      const readHook = await reader.read(deployedHook.deployed.address);

      // Verify gas configs were updated
      expect(readHook.config.overhead[DOMAIN_1]).to.equal(60000);
      expect(readHook.config.overhead[DOMAIN_2]).to.equal(100000);
      expect(readHook.config.oracleConfig[DOMAIN_1].gasPrice).to.equal(
        '2000000000',
      );
      expect(readHook.config.oracleConfig[DOMAIN_2].gasPrice).to.equal(
        '3000000000',
      );

      // Verify ownership was transferred
      expect(eqAddressRadix(readHook.config.owner, TEST_RADIX_BURN_ADDRESS)).to
        .be.true;
    });
  });

  describe('Generic hook reading via readHook', () => {
    it('should detect and read MerkleTree hook', async () => {
      const config: MerkleTreeHookConfig = {
        type: AltVM.HookType.MERKLE_TREE,
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.MERKLE_TREE,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config });

      // Read via generic readHook (without knowing the type)
      const readHook = await artifactManager.readHook(
        deployedHook.deployed.address,
      );

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.config.type).to.equal(AltVM.HookType.MERKLE_TREE);
      expect(readHook.deployed.address).to.equal(deployedHook.deployed.address);
    });

    it('should detect and read IGP hook', async () => {
      const config: IgpHookConfig = {
        type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        beneficiary: TEST_RADIX_DEPLOYER_ADDRESS,
        oracleKey: TEST_RADIX_DEPLOYER_ADDRESS,
        overhead: {
          [DOMAIN_1]: 50000,
        },
        oracleConfig: {
          [DOMAIN_1]: {
            gasPrice: '1000000000',
            tokenExchangeRate: '10000000000',
          },
        },
      };

      const writer = artifactManager.createWriter(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
        radixSigner,
      );
      const [deployedHook] = await writer.create({ config });

      // Read via generic readHook (without knowing the type)
      const readHook = await artifactManager.readHook(
        deployedHook.deployed.address,
      );

      expect(readHook.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readHook.config.type).to.equal(
        AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect(readHook.deployed.address).to.equal(deployedHook.deployed.address);
    });
  });
});
