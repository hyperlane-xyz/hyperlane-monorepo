import { address, type Address } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { MailboxOnChain } from '@hyperlane-xyz/provider-sdk/mailbox';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxArtifactManager } from '../core/mailbox-artifact-manager.js';
import { SvmMailboxReader, SvmMailboxWriter } from '../core/mailbox.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';
const TEST_PRIVATE_KEY_2 =
  '0x0000000000000000000000000000000000000000000000000000000000000002';
const TEST_PRIVATE_KEY_3 =
  '0x0000000000000000000000000000000000000000000000000000000000000003';

describe('SVM Mailbox E2E Tests', () => {
  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let testIsmAddress: Address;
  let mailboxWriter: SvmMailboxWriter;

  function makeMailboxConfig(
    overrides: Partial<MailboxOnChain> = {},
  ): MailboxOnChain {
    return {
      owner: signer.getSignerAddress(),
      defaultIsm: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: testIsmAddress },
      },
      defaultHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: TEST_PROGRAM_IDS.mailbox },
      },
      requiredHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: TEST_PROGRAM_IDS.mailbox },
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

  beforeAll(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 50_000_000_000n);

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

    mailboxWriter = new SvmMailboxWriter(
      {
        program: { programId: TEST_PROGRAM_IDS.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );
  });

  describe('Mailbox', () => {
    it('should deploy, initialize, and read mailbox', async () => {
      const config = makeMailboxConfig();
      const [deployed, receipts] = await mailboxWriter.create({ config });

      expect(receipts.length).toBeGreaterThan(0);
      expect(deployed.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).toBe(TEST_PROGRAM_IDS.mailbox);
      expect(deployed.deployed.domainId).toBe(TEST_SVM_CHAIN_METADATA.domainId);

      // Verify on-chain state via read().
      const onChain = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      expect(onChain.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(onChain.config.owner).toBe(signer.getSignerAddress());
      expect(onChain.config.defaultIsm.deployed.address).toBe(testIsmAddress);
      expect(onChain.deployed.domainId).toBe(TEST_SVM_CHAIN_METADATA.domainId);
    });

    it('should return empty transactions when config matches', async () => {
      const current = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      const updateTxs = await mailboxWriter.update(current);
      expect(updateTxs).toHaveLength(0);
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
      const current = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      expect(current.config.defaultIsm.deployed.address).toBe(testIsmAddress);

      const updateTxs = await mailboxWriter.update({
        ...current,
        config: makeMailboxConfig({
          defaultIsm: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: secondIsmAddress },
          },
        }),
      });
      expect(updateTxs.length).toBeGreaterThan(0);
      expect(updateTxs[0].annotation).toContain('set default ISM');
      await executeUpdateTxs(updateTxs);

      // Verify on-chain.
      const updated = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      expect(updated.config.defaultIsm.deployed.address).toBe(secondIsmAddress);

      // Restore original ISM so subsequent tests are unaffected.
      const restoreTxs = await mailboxWriter.update({
        ...updated,
        config: makeMailboxConfig(),
      });
      await executeUpdateTxs(restoreTxs);

      const restored = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      expect(restored.config.defaultIsm.deployed.address).toBe(testIsmAddress);
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
      const current = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      const transferTxs = await mailboxWriter.update({
        ...current,
        config: makeMailboxConfig({
          owner: newOwnerSigner.getSignerAddress(),
        }),
      });
      expect(transferTxs.length).toBeGreaterThan(0);
      await executeUpdateTxs(transferTxs);

      const afterTransfer = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      expect(afterTransfer.config.owner).toBe(
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

      const restored = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      expect(restored.config.owner).toBe(signer.getSignerAddress());
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
      const current = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      const transferTxs = await mailboxWriter.update({
        ...current,
        config: makeMailboxConfig({
          owner: throwawayOwner.getSignerAddress(),
        }),
      });
      await executeUpdateTxs(transferTxs);

      // Renounce from throwaway.
      const afterTransfer = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      const renounceTxs = await mailboxWriter.update({
        ...afterTransfer,
        config: makeMailboxConfig({
          owner: ZERO_ADDRESS_HEX_32,
        }),
      });
      expect(renounceTxs.length).toBeGreaterThan(0);
      for (const tx of renounceTxs) {
        await throwawayOwner.send({ instructions: tx.instructions });
      }

      const renounced = await mailboxWriter.read(TEST_PROGRAM_IDS.mailbox);
      expect(renounced.config.owner).toBe(ZERO_ADDRESS_HEX_32);
    });
  });

  describe('Mailbox Artifact Manager', () => {
    it('should read mailbox via artifact manager', async () => {
      const manager = new SvmMailboxArtifactManager(
        rpc,
        TEST_SVM_CHAIN_METADATA.domainId,
      );

      const artifact = await manager.readMailbox(TEST_PROGRAM_IDS.mailbox);
      expect(artifact.artifactState).toBe(ArtifactState.DEPLOYED);
      expect(artifact.deployed.address).toBe(TEST_PROGRAM_IDS.mailbox);
    });

    it('should create readers and writers', () => {
      const manager = new SvmMailboxArtifactManager(
        rpc,
        TEST_SVM_CHAIN_METADATA.domainId,
      );

      const reader = manager.createReader('mailbox');
      expect(reader).toBeInstanceOf(SvmMailboxReader);

      const writer = manager.createWriter('mailbox', signer);
      expect(writer).toBeInstanceOf(SvmMailboxWriter);
    });
  });
});
