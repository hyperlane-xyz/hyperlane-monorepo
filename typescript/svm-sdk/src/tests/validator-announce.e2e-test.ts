import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxWriter } from '../core/mailbox.js';
import { SvmValidatorAnnounceArtifactManager } from '../core/validator-announce-artifact-manager.js';
import {
  SvmValidatorAnnounceReader,
  SvmValidatorAnnounceWriter,
} from '../core/validator-announce.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Validator Announce E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let vaWriter: SvmValidatorAnnounceWriter;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 50_000_000_000n);

    // Deploy Test ISM — required for mailbox init.
    const testIsmAddress: Address = TEST_PROGRAM_IDS.testIsm;
    const ismWriter = new SvmTestIsmWriter(
      { program: { programId: testIsmAddress } },
      rpc,
      signer,
    );
    await ismWriter.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    // Deploy Mailbox — required as the mailbox reference for validator announce.
    const mailboxWriter = new SvmMailboxWriter(
      {
        program: { programId: TEST_PROGRAM_IDS.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );
    await mailboxWriter.create({
      config: {
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
      },
    });

    vaWriter = new SvmValidatorAnnounceWriter(
      {
        program: { programId: TEST_PROGRAM_IDS.validatorAnnounce },
        localDomain: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );
  });

  describe('Validator Announce', () => {
    it('should deploy, initialize, and read validator announce', async () => {
      const [deployed, receipts] = await vaWriter.create({
        config: {
          mailboxAddress: TEST_PROGRAM_IDS.mailbox,
        },
      });

      expect(receipts.length).to.be.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.deployed.address).to.equal(
        TEST_PROGRAM_IDS.validatorAnnounce,
      );
      expect(deployed.config.mailboxAddress).to.equal(TEST_PROGRAM_IDS.mailbox);

      // Verify on-chain state via read().
      const reader = new SvmValidatorAnnounceReader(rpc);
      const onChain = await reader.read(TEST_PROGRAM_IDS.validatorAnnounce);

      expect(onChain.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(onChain.config.mailboxAddress).to.equal(TEST_PROGRAM_IDS.mailbox);
    });

    it('should return empty transactions for update (no mutable config)', async () => {
      const updateTxs = await vaWriter.update({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          mailboxAddress: TEST_PROGRAM_IDS.mailbox,
        },
        deployed: {
          address: TEST_PROGRAM_IDS.validatorAnnounce,
        },
      });

      expect(updateTxs).to.have.length(0);
    });
  });

  describe('Validator Announce Artifact Manager', () => {
    it('should read validator announce via artifact manager', async () => {
      const manager = new SvmValidatorAnnounceArtifactManager(
        rpc,
        TEST_SVM_CHAIN_METADATA.domainId,
      );

      const artifact = await manager.readValidatorAnnounce(
        TEST_PROGRAM_IDS.validatorAnnounce,
      );
      expect(artifact.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(artifact.deployed.address).to.equal(
        TEST_PROGRAM_IDS.validatorAnnounce,
      );
    });

    it('should create readers and writers', () => {
      const manager = new SvmValidatorAnnounceArtifactManager(
        rpc,
        TEST_SVM_CHAIN_METADATA.domainId,
      );

      const reader = manager.createReader('validatorAnnounce');
      expect(reader).to.be.instanceOf(SvmValidatorAnnounceReader);

      const writer = manager.createWriter('validatorAnnounce', signer);
      expect(writer).to.be.instanceOf(SvmValidatorAnnounceWriter);
    });
  });
});
