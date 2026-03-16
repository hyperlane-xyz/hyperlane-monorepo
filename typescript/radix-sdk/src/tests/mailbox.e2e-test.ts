import { expect } from 'chai';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { MailboxOnChain } from '@hyperlane-xyz/provider-sdk/mailbox';
import { ZERO_ADDRESS_HEX_32, assert } from '@hyperlane-xyz/utils';

import { RadixSigner } from '../clients/signer.js';
import { RadixMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_RADIX_BURN_ADDRESS,
  TEST_RADIX_DEPLOYER_ADDRESS,
  TEST_RADIX_PRIVATE_KEY,
} from '../testing/constants.js';

import { DEPLOYED_TEST_CHAIN_METADATA } from './e2e-test.setup.js';

describe('Radix Mailbox (e2e)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let radixSigner: RadixSigner;
  let artifactManager: RadixMailboxArtifactManager;

  // Test domain ID for mailbox
  const TEST_DOMAIN_ID = 999999;

  // We'll create test ISM and Hook addresses (can be burn address for testing)
  const TEST_ISM_ADDRESS = TEST_RADIX_BURN_ADDRESS;
  const TEST_HOOK_ADDRESS = TEST_RADIX_BURN_ADDRESS;

  before(async () => {
    const rpcUrls =
      DEPLOYED_TEST_CHAIN_METADATA.rpcUrls?.map((url) => url.http) ?? [];
    assert(rpcUrls.length > 0, 'Expected at least 1 rpc url for the tests');

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

    const gateway = (radixSigner as any).gateway;
    const base = (radixSigner as any).base;
    artifactManager = new RadixMailboxArtifactManager(
      gateway,
      base,
      TEST_DOMAIN_ID,
    );
  });

  describe('Mailbox Artifact Operations', () => {
    it('should create a mailbox with ISM and hooks', async () => {
      const config: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_ISM_ADDRESS },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const writer = artifactManager.createWriter('mailbox', radixSigner);
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.owner).to.equal(TEST_RADIX_DEPLOYER_ADDRESS);
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      expect(result.deployed.domainId).to.equal(TEST_DOMAIN_ID);
      expect(receipts).to.be.an('array').with.length.greaterThan(0);

      // Verify all setters were called (create + 3 setters + optional owner transfer)
      // Should be at least 4 receipts (create + setIsm + setDefaultHook + setRequiredHook)
      expect(receipts.length).to.be.greaterThanOrEqual(4);
    });

    it('should skip optional mailbox setters when zero addresses are provided', async () => {
      const zeroAddressConfig: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ZERO_ADDRESS_HEX_32 },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ZERO_ADDRESS_HEX_32 },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ZERO_ADDRESS_HEX_32 },
        },
      };

      const writer = artifactManager.createWriter('mailbox', radixSigner);
      const [deployedMailbox, receipts] = await writer.create({
        config: zeroAddressConfig,
      });

      expect(receipts).to.be.an('array').with.length(1);

      const reader = artifactManager.createReader('mailbox');
      const readMailbox = await reader.read(deployedMailbox.deployed.address);

      expect(readMailbox.config.defaultIsm.deployed.address).to.equal(
        ZERO_ADDRESS_HEX_32,
      );
      expect(readMailbox.config.defaultHook.deployed.address).to.equal(
        ZERO_ADDRESS_HEX_32,
      );
      expect(readMailbox.config.requiredHook.deployed.address).to.equal(
        ZERO_ADDRESS_HEX_32,
      );
    });

    it('should read a mailbox configuration from chain', async () => {
      const config: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_ISM_ADDRESS },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const writer = artifactManager.createWriter('mailbox', radixSigner);
      const [deployedMailbox] = await writer.create({ config });

      const reader = artifactManager.createReader('mailbox');
      const readMailbox = await reader.read(deployedMailbox.deployed.address);

      expect(readMailbox.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readMailbox.config.owner).to.equal(TEST_RADIX_DEPLOYER_ADDRESS);
      expect(readMailbox.deployed.address).to.equal(
        deployedMailbox.deployed.address,
      );
      expect(readMailbox.deployed.domainId).to.equal(TEST_DOMAIN_ID);

      // Verify ISM and hooks are set correctly
      expect(readMailbox.config.defaultIsm.deployed.address).to.equal(
        TEST_ISM_ADDRESS,
      );
      expect(readMailbox.config.defaultHook.deployed.address).to.equal(
        TEST_HOOK_ADDRESS,
      );
      expect(readMailbox.config.requiredHook.deployed.address).to.equal(
        TEST_HOOK_ADDRESS,
      );
    });

    it('should update mailbox when ISM changes', async () => {
      // Create initial mailbox
      const initialConfig: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_ISM_ADDRESS },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const writer = artifactManager.createWriter('mailbox', radixSigner);
      const [deployedMailbox] = await writer.create({ config: initialConfig });

      // Update with new ISM address (use deployer address as different address)
      const newIsmAddress = TEST_RADIX_DEPLOYER_ADDRESS;
      const updatedConfig: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: newIsmAddress },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const updateTxs = await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: updatedConfig,
        deployed: deployedMailbox.deployed,
      });

      // Should have 1 transaction to update the ISM
      expect(updateTxs).to.be.an('array').with.length(1);
      expect(updateTxs[0].annotation).to.include('default ISM');
    });

    it('should update mailbox when owner changes', async () => {
      // Create initial mailbox
      const initialConfig: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_ISM_ADDRESS },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const writer = artifactManager.createWriter('mailbox', radixSigner);
      const [deployedMailbox] = await writer.create({ config: initialConfig });

      // Update with new owner
      const newOwner = TEST_RADIX_BURN_ADDRESS;
      const updatedConfig: MailboxOnChain = {
        owner: newOwner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_ISM_ADDRESS },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const updateTxs = await writer.update({
        artifactState: ArtifactState.DEPLOYED,
        config: updatedConfig,
        deployed: deployedMailbox.deployed,
      });

      // Should have 1 transaction to transfer ownership
      expect(updateTxs).to.be.an('array').with.length(1);
      expect(updateTxs[0].annotation).to.include('ownership');
    });

    it('should return no transactions when mailbox state matches desired state', async () => {
      // Create mailbox
      const config: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_ISM_ADDRESS },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const writer = artifactManager.createWriter('mailbox', radixSigner);
      const [deployedMailbox] = await writer.create({ config });

      // Update with same config
      const updateTxs = await writer.update(deployedMailbox);

      // Should have no update transactions since nothing changed
      expect(updateTxs).to.be.an('array').with.length(0);
    });

    it('should use readMailbox convenience method', async () => {
      const config: MailboxOnChain = {
        owner: TEST_RADIX_DEPLOYER_ADDRESS,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_ISM_ADDRESS },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_HOOK_ADDRESS },
        },
      };

      const writer = artifactManager.createWriter('mailbox', radixSigner);
      const [deployedMailbox] = await writer.create({ config });

      // Use the convenience method
      const readMailbox = await artifactManager.readMailbox(
        deployedMailbox.deployed.address,
      );

      expect(readMailbox.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readMailbox.deployed.address).to.equal(
        deployedMailbox.deployed.address,
      );
    });
  });
});
