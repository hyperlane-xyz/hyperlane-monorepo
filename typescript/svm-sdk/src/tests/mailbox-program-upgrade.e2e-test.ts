import { address, type Address } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { before, describe, it } from 'mocha';

chai.use(chaiAsPromised);

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { MailboxOnChain } from '@hyperlane-xyz/provider-sdk/mailbox';
import { sleep } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxReader, SvmMailboxWriter } from '../core/mailbox.js';
import { getProgramUpgradeAuthority } from '../deploy/program-deployer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { LEGACY_SVM_PROGRAM_BYTES } from '../testing/legacy/legacy-program-bytes.js';
import { TEST_PROGRAM_IDS, airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// `skipPreflight` and the post-send sleep below are test-validator-only
// workarounds. On mainnet the signer waits for the tx to land on chain, which
// gives the cluster time to refresh its program cache before the next read.
// The local test validator confirms much faster, so without these guards the
// follow-up read can race the validator's program cache and see stale state.

describe('SVM Mailbox Program Upgrade E2E Tests', function () {
  this.timeout(600_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let testIsmAddress: Address;

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
        deployed: { address: testIsmAddress },
      },
      requiredHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: testIsmAddress },
      },
      ...overrides,
    };
  }

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    // Deploy the shared test ISM used as the default ISM for every mailbox
    // deployed below.
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
  });

  it('should deploy with legacy bytes, upgrade, and read new version', async () => {
    const legacyWriter = new SvmMailboxWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );

    const [deployed] = await legacyWriter.create({
      artifactState: ArtifactState.NEW,
      config: makeMailboxConfig(),
    });

    const legacyRead = await legacyWriter.read(deployed.deployed.address);
    expect(legacyRead.config.contractVersion).to.be.undefined;

    const newWriter = new SvmMailboxWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );

    const updateTxs = await newWriter.update({
      ...legacyRead,
      config: {
        ...legacyRead.config,
        contractVersion: '1.0.0',
      },
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    for (const tx of updateTxs) {
      await signer.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }

    await sleep(1000);
    const upgraded = await new SvmMailboxReader(rpc).read(
      deployed.deployed.address,
    );
    expect(upgraded.config.contractVersion).to.equal('1.0.0');
  });

  it('should reject downgrade attempt', async () => {
    const writer = new SvmMailboxWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );

    const [deployed] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: makeMailboxConfig(),
    });

    const current = await writer.read(deployed.deployed.address);
    expect(current.config.contractVersion).to.equal('1.0.0');

    await expect(
      writer.update({
        ...current,
        config: {
          ...current.config,
          contractVersion: '0.1.0',
        },
      }),
    ).to.be.rejectedWith('Cannot downgrade');
  });

  it('should skip upgrade when contractVersion matches', async () => {
    const writer = new SvmMailboxWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );

    const [deployed] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: makeMailboxConfig(),
    });

    const current = await writer.read(deployed.deployed.address);

    const updateTxs = await writer.update({
      ...current,
      config: {
        ...current.config,
        contractVersion: current.config.contractVersion,
      },
    });

    expect(updateTxs).to.have.length(0);
  });

  it('should apply upgrade, ISM swap, and ownership transfer in one update', async () => {
    // Deploy a legacy mailbox owned by signer.
    const legacyWriter = new SvmMailboxWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );

    const [deployed] = await legacyWriter.create({
      artifactState: ArtifactState.NEW,
      config: makeMailboxConfig(),
    });
    const programId = deployed.deployed.address;

    // Deploy a second test ISM from bytes so we have a distinct default-ISM
    // address to mutate to during the upgrade update.
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

    // Upgrade + change default ISM + transfer ownership in a single update.
    const newOwner = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      '0x0000000000000000000000000000000000000000000000000000000000000004',
    );
    await airdropSol(rpc, address(newOwner.getSignerAddress()), 5_000_000_000n);

    const upgradeWriter = new SvmMailboxWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.mailbox },
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      rpc,
      signer,
    );

    const current = await legacyWriter.read(programId);
    const allTxs = await upgradeWriter.update({
      ...current,
      config: {
        ...current.config,
        contractVersion: '1.0.0',
        owner: newOwner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: secondIsmAddress },
        },
      },
    });

    for (const tx of allTxs) {
      await signer.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }

    await sleep(1000);
    const afterUpdate = await upgradeWriter.read(programId);
    expect(afterUpdate.config.contractVersion).to.equal('1.0.0');
    expect(afterUpdate.config.owner).to.equal(newOwner.getSignerAddress());
    expect(afterUpdate.config.defaultIsm.deployed.address).to.equal(
      secondIsmAddress,
    );
    expect(await getProgramUpgradeAuthority(rpc, address(programId))).to.equal(
      newOwner.getSignerAddress(),
    );
  });
});
