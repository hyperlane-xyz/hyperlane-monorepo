import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { sleep } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { LEGACY_SVM_PROGRAM_BYTES } from '../hyperlane/legacy-program-bytes.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import {
  TEST_ATA_PAYER_FUNDING_AMOUNT,
  TEST_PROGRAM_IDS,
  airdropSol,
  createSplMint,
} from '../testing/setup.js';
import {
  SvmCollateralTokenReader,
  SvmCollateralTokenWriter,
} from '../warp/collateral-token.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Program Upgrade E2E Tests', function () {
  this.timeout(600_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let collateralMint: Address;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 50_000_000_000n);
    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    collateralMint = await createSplMint(rpc, signer, 9);

    const igpConfig: IgpHookConfig = {
      type: 'interchainGasPaymaster',
      owner: signer.getSignerAddress(),
      beneficiary: signer.getSignerAddress(),
      oracleKey: signer.getSignerAddress(),
      overhead: { 1: 50000 },
      oracleConfig: {
        1: { gasPrice: '1', tokenExchangeRate: '1000000000000000000' },
      },
    };
    const igpWriter = new SvmIgpHookWriter(
      { program: { programId: TEST_PROGRAM_IDS.igp } },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );
    await igpWriter.create({
      artifactState: ArtifactState.NEW,
      config: igpConfig,
    });
  });

  it('should deploy with legacy bytes, upgrade, and read new version', async () => {
    const legacyWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );

    const [deployed] = await legacyWriter.create({
      config: {
        type: TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
      },
    });

    const programId = deployed.deployed.address;

    // Read — legacy program should have no contractVersion
    const reader = new SvmCollateralTokenReader(rpc);
    const beforeUpgrade = await reader.read(programId);
    expect(beforeUpgrade.config.contractVersion).to.be.undefined;

    // Update with new bytes and contractVersion to trigger upgrade
    const upgradeWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );

    const updateTxs = await upgradeWriter.update({
      ...beforeUpgrade,
      config: {
        ...beforeUpgrade.config,
        contractVersion: '1.0.0',
      },
    });

    // Expect 2 authority txs: extend (new binary is larger) + upgrade
    expect(updateTxs).to.have.length(2);
    for (const tx of updateTxs) {
      await signer.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }

    // Wait for the upgrade to take effect (binary swap needs a slot advance)
    await sleep(1000);

    const afterUpgrade = await reader.read(programId);
    expect(afterUpgrade.config.contractVersion).to.equal('1.0.0');
  });

  it('should upgrade when authority differs from payer', async () => {
    // Signer A deploys with legacy bytes
    const signerA = signer;
    const legacyWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signerA,
    );

    const [deployed] = await legacyWriter.create({
      config: {
        type: TokenType.collateral,
        owner: signerA.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
      },
    });

    const programId = deployed.deployed.address;

    // Transfer ownership + upgrade authority to Signer B
    const signerB = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    );
    await airdropSol(rpc, address(signerB.getSignerAddress()), 10_000_000_000n);

    const current = await legacyWriter.read(programId);
    const transferTxs = await legacyWriter.update({
      ...current,
      config: {
        ...current.config,
        owner: signerB.getSignerAddress(),
      },
    });
    for (const tx of transferTxs) {
      await signerA.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
      });
    }

    // Verify Signer B is now the owner
    const afterTransfer = await legacyWriter.read(programId);
    expect(afterTransfer.config.owner).to.equal(signerB.getSignerAddress());

    // Signer A generates upgrade txs (pays for buffer) but upgrade authority is Signer B
    const upgradeWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signerA,
    );

    const updateTxs = await upgradeWriter.update({
      ...afterTransfer,
      config: {
        ...afterTransfer.config,
        contractVersion: '1.0.0',
      },
    });

    // Expect 2 authority txs: extend + upgrade, both with feePayer = signerB
    expect(updateTxs).to.have.length(2);
    for (const tx of updateTxs) {
      expect(tx.feePayer).to.equal(signerB.getSignerAddress());
    }

    for (const tx of updateTxs) {
      await signerB.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }

    // Wait for the upgrade to take effect (binary swap needs a slot advance)
    await sleep(1000);

    const afterUpgrade = await upgradeWriter.read(programId);
    expect(afterUpgrade.config.contractVersion).to.equal('1.0.0');
  });

  it('should reject downgrade attempt', async () => {
    const writer = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );

    const [deployed] = await writer.create({
      config: {
        type: TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
      },
    });

    const current = await writer.read(deployed.deployed.address);
    expect(current.config.contractVersion).to.equal('1.0.0');

    try {
      await writer.update({
        ...current,
        config: {
          ...current.config,
          contractVersion: '0.1.0',
        },
      });
      expect.fail('Should have thrown on downgrade');
    } catch (e: unknown) {
      expect((e as Error).message).to.include('Cannot downgrade');
    }
  });

  it('should skip upgrade when contractVersion matches', async () => {
    const writer = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );

    const [deployed] = await writer.create({
      config: {
        type: TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
      },
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
});
