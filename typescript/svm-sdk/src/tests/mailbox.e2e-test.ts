import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import {
  ArtifactComposition,
  ArtifactState,
  type WithCompositionVariant,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { MailboxOnChain } from '@hyperlane-xyz/provider-sdk/mailbox';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxArtifactManager } from '../core/mailbox-artifact-manager.js';
import { SvmMailboxReader, SvmMailboxWriter } from '../core/mailbox.js';
import { getProgramUpgradeAuthority } from '../deploy/program-deployer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';
import { FALLBACK_SIMULATION_PAYER } from '../version/version-query.js';

type OrchestratedMailboxOnChain = WithCompositionVariant<
  MailboxOnChain,
  typeof ArtifactComposition.ORCHESTRATED
>;

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';
const TEST_PRIVATE_KEY_2 =
  '0x0000000000000000000000000000000000000000000000000000000000000002';
const TEST_PRIVATE_KEY_3 =
  '0x0000000000000000000000000000000000000000000000000000000000000003';

describe('SVM Mailbox E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let testIsmAddress: Address;
  let mailboxWriter: SvmMailboxWriter;
  let mailboxAddress: Address;

  function makeMailboxConfig(
    overrides: Partial<OrchestratedMailboxOnChain> = {},
  ): OrchestratedMailboxOnChain {
    return {
      composition: ArtifactComposition.ORCHESTRATED,
      owner: signer.getSignerAddress(),
      defaultIsm: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: testIsmAddress },
      },
      defaultHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: mailboxAddress },
      },
      requiredHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: mailboxAddress },
      },
      ...overrides,
    };
  }

  async function executeUpdateTxs(
    txs: Awaited<ReturnType<SvmMailboxWriter['update']>>,
  ): Promise<void> {
    for (const tx of txs) {
      await signer.send({ instructions: tx.instructions });
    }
  }

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 50_000_000_000n);
    // Fund the simulation fallback payer so `read()` after renounce (owner
    // becomes null) can still simulate GetProgramVersion via the fallback
    // path. Mainnet has this address funded; localnet does not.
    await airdropSol(rpc, FALLBACK_SIMULATION_PAYER, 10_000_000_000n);

    // Deploy Test ISM — required as the default ISM for mailbox init.
    testIsmAddress = TEST_PROGRAM_IDS.testIsm;
    const ismWriter = new SvmTestIsmWriter(
      { program: { programId: testIsmAddress } },
      rpc,
      signer,
    );
    await ismWriter.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    // Deploy the mailbox fresh from bytes so the test signer becomes the
    // BPF upgrade authority. Existing tests share this single deployment.
    mailboxWriter = new SvmMailboxWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );
    const [deployedMailbox, deployReceipts] = await mailboxWriter.create({
      artifactState: ArtifactState.NEW,
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
        owner: signer.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: testIsmAddress },
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
    });
    expect(deployReceipts.length).to.be.greaterThan(0);
    mailboxAddress = address(deployedMailbox.deployed.address);
  });

  describe('Mailbox', () => {
    it('should read the deployed mailbox', async () => {
      const onChain = await mailboxWriter.read(mailboxAddress);
      expect(onChain.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(onChain.config.owner).to.equal(signer.getSignerAddress());
      expect(onChain.config.defaultIsm.deployed.address).to.equal(
        testIsmAddress,
      );
      expect(onChain.config.contractVersion).to.equal('1.0.0');
      expect(onChain.deployed.domainId).to.equal(
        TEST_SVM_CHAIN_METADATA.domainId,
      );
    });

    it('should return empty transactions when config matches', async () => {
      const current = await mailboxWriter.read(mailboxAddress);
      const updateTxs = await mailboxWriter.update(current);
      expect(updateTxs).to.have.length(0);
    });

    it('should update default ISM via update()', async () => {
      // Deploy a second test ISM from bytes to get a different ISM address.
      const secondIsmWriter = new SvmTestIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.testIsm } },
        rpc,
        signer,
      );
      const [secondIsm] = await secondIsmWriter.create({
        artifactState: ArtifactState.NEW,
        config: { type: 'testIsm' },
      });
      const secondIsmAddress = secondIsm.deployed.address;

      // Read current state and update default ISM.
      const current = await mailboxWriter.read(mailboxAddress);
      expect(current.config.defaultIsm.deployed.address).to.equal(
        testIsmAddress,
      );

      const updateTxs = await mailboxWriter.update({
        ...current,
        config: makeMailboxConfig({
          defaultIsm: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: secondIsmAddress },
          },
        }),
      });
      expect(updateTxs.length).to.be.greaterThan(0);
      expect(updateTxs[0].annotation).to.include('set default ISM');
      await executeUpdateTxs(updateTxs);

      // Verify on-chain.
      const updated = await mailboxWriter.read(mailboxAddress);
      expect(updated.config.defaultIsm.deployed.address).to.equal(
        secondIsmAddress,
      );

      // Restore original ISM so subsequent tests are unaffected.
      const restoreTxs = await mailboxWriter.update({
        ...updated,
        config: makeMailboxConfig(),
      });
      await executeUpdateTxs(restoreTxs);

      const restored = await mailboxWriter.read(mailboxAddress);
      expect(restored.config.defaultIsm.deployed.address).to.equal(
        testIsmAddress,
      );
    });

    it('should transfer ownership and allow new owner to update', async () => {
      const newOwnerSigner = await SvmSigner.connectWithSigner(
        [TEST_SVM_CHAIN_METADATA.rpcUrl],
        TEST_PRIVATE_KEY_2,
      );
      await airdropSol(
        rpc,
        address(newOwnerSigner.getSignerAddress()),
        10_000_000_000n,
      );

      // Transfer ownership to new keypair.
      const current = await mailboxWriter.read(mailboxAddress);
      const transferTxs = await mailboxWriter.update({
        ...current,
        config: makeMailboxConfig({
          owner: newOwnerSigner.getSignerAddress(),
        }),
      });
      expect(transferTxs.length).to.be.greaterThan(0);
      await executeUpdateTxs(transferTxs);

      const afterTransfer = await mailboxWriter.read(mailboxAddress);
      expect(afterTransfer.config.owner).to.equal(
        newOwnerSigner.getSignerAddress(),
      );
      expect(await getProgramUpgradeAuthority(rpc, mailboxAddress)).to.equal(
        newOwnerSigner.getSignerAddress(),
      );

      // Transfer back so subsequent tests still work.
      const transferBackTxs = await mailboxWriter.update({
        ...afterTransfer,
        config: makeMailboxConfig({
          owner: signer.getSignerAddress(),
        }),
      });
      for (const tx of transferBackTxs) {
        await newOwnerSigner.send({ instructions: tx.instructions });
      }

      const restored = await mailboxWriter.read(mailboxAddress);
      expect(restored.config.owner).to.equal(signer.getSignerAddress());
      expect(await getProgramUpgradeAuthority(rpc, mailboxAddress)).to.equal(
        signer.getSignerAddress(),
      );
    });

    it('should renounce ownership via update', async () => {
      // Use a throwaway owner since renouncing is irreversible.
      const throwawayOwner = await SvmSigner.connectWithSigner(
        [TEST_SVM_CHAIN_METADATA.rpcUrl],
        TEST_PRIVATE_KEY_3,
      );
      await airdropSol(
        rpc,
        address(throwawayOwner.getSignerAddress()),
        10_000_000_000n,
      );

      // Transfer to throwaway first.
      const current = await mailboxWriter.read(mailboxAddress);
      const transferTxs = await mailboxWriter.update({
        ...current,
        config: makeMailboxConfig({
          owner: throwawayOwner.getSignerAddress(),
        }),
      });
      await executeUpdateTxs(transferTxs);

      // Renounce from throwaway.
      const afterTransfer = await mailboxWriter.read(mailboxAddress);
      expect(await getProgramUpgradeAuthority(rpc, mailboxAddress)).to.equal(
        throwawayOwner.getSignerAddress(),
      );
      const renounceTxs = await mailboxWriter.update({
        ...afterTransfer,
        config: makeMailboxConfig({
          owner: ZERO_ADDRESS_HEX_32,
        }),
      });
      expect(renounceTxs.length).to.be.greaterThan(0);
      for (const tx of renounceTxs) {
        await throwawayOwner.send({ instructions: tx.instructions });
      }

      const renounced = await mailboxWriter.read(mailboxAddress);
      expect(renounced.config.owner).to.equal(ZERO_ADDRESS_HEX_32);
      expect(await getProgramUpgradeAuthority(rpc, mailboxAddress)).to.be.null;
    });
  });

  describe('Mailbox Artifact Manager', () => {
    it('should read mailbox via artifact manager', async () => {
      const manager = new SvmMailboxArtifactManager(
        rpc,
        TEST_SVM_CHAIN_METADATA.domainId,
      );

      const artifact = await manager.readMailbox(mailboxAddress);
      expect(artifact.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(artifact.deployed.address).to.equal(mailboxAddress);
    });

    it('should create readers and writers', () => {
      const manager = new SvmMailboxArtifactManager(
        rpc,
        TEST_SVM_CHAIN_METADATA.domainId,
      );

      const reader = manager.createReader('mailbox');
      expect(reader).to.be.instanceOf(SvmMailboxReader);

      const writer = manager.createWriter('mailbox', signer);
      expect(writer).to.be.instanceOf(SvmMailboxWriter);
    });
  });
});
