import { address, type Address } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { before, describe, it } from 'mocha';

chai.use(chaiAsPromised);

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { FeeParamsType, FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { sleep } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { SvmMailboxWriter } from '../core/mailbox.js';
import { SvmLinearFeeWriter } from '../fee/linear-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { SvmTestIsmWriter } from '../ism/test-ism.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { LEGACY_SVM_PROGRAM_BYTES } from '../testing/legacy/legacy-program-bytes.js';
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
import { supportsFeeConfig } from '../version/version-query.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// `skipPreflight` and the post-send sleep below are test-validator-only
// workarounds. On mainnet the signer waits for the tx to land on chain, which
// gives the cluster time to refresh its program cache before the next read.
// The local test validator confirms much faster, so without these guards the
// follow-up read can race the validator's program cache and see stale state.

describe('SVM Program Upgrade E2E Tests', function () {
  this.timeout(600_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let collateralMint: Address;
  let feeProgramId: Address;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);
    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    collateralMint = await createSplMint(rpc, signer, 9);

    // Setup IGP for tests that use hook
    const igpWriter = new SvmIgpHookWriter(
      { program: { programId: TEST_PROGRAM_IDS.igp } },
      rpc,
      DEFAULT_IGP_SALT,
      signer,
    );
    await igpWriter.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: 'interchainGasPaymaster',
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        oracleKey: signer.getSignerAddress(),
        overhead: { 1: 50000 },
        oracleConfig: {
          1: { gasPrice: '1', tokenExchangeRate: '1000000000000000000' },
        },
      } satisfies IgpHookConfig,
    });

    const testIsmAddress = TEST_PROGRAM_IDS.testIsm;
    const ismWriter = new SvmTestIsmWriter(
      { program: { programId: testIsmAddress } },
      rpc,
      signer,
    );
    await ismWriter.create({
      artifactState: ArtifactState.NEW,
      config: { type: 'testIsm' },
    });

    // Initialize mailbox — SetFeeConfig reads localDomain from the outbox PDA
    const mailboxWriter = new SvmMailboxWriter(
      {
        program: { programId: mailboxAddress },
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
          deployed: { address: mailboxAddress },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: mailboxAddress },
        },
      },
    });

    // Deploy a fee program for post-upgrade fee config test
    const feeWriter = new SvmLinearFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      TEST_SVM_CHAIN_METADATA.domainId,
      signer,
      DEFAULT_FEE_SALT,
    );
    const [deployedFee] = await feeWriter.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: {
          type: FeeParamsType.raw,
          maxFee: '1000000',
          halfAmount: '500000',
        },
      },
    });
    feeProgramId = address(deployedFee.deployed.programId);
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

    const legacyRead = await legacyWriter.read(deployed.deployed.address);
    expect(legacyRead.config.contractVersion).to.be.undefined;

    const newWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
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
    const upgraded = await new SvmCollateralTokenReader(rpc).read(
      deployed.deployed.address,
    );
    expect(upgraded.config.contractVersion).to.be.a('string');
    expect(supportsFeeConfig(upgraded.config.contractVersion)).to.equal(true);
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

  it('should be fully functional after upgrade from legacy', async () => {
    // Deploy with legacy binary and all options filled
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
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.testIsm },
        },
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.igp },
        },
        remoteRouters: {
          1: {
            address:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
        },
        destinationGas: { 1: '100000' },
      },
    });

    const programId = deployed.deployed.address;

    // Upgrade + set fee config + transfer ownership in one update
    const upgradeWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
        feeSalt: DEFAULT_FEE_SALT,
      },
      rpc,
      signer,
    );

    const current = await legacyWriter.read(programId);

    const newOwner = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      '0x0000000000000000000000000000000000000000000000000000000000000004',
    );
    await airdropSol(rpc, address(newOwner.getSignerAddress()), 5_000_000_000n);

    const allTxs = await upgradeWriter.update({
      ...current,
      config: {
        ...current.config,
        contractVersion: '1.0.0',
        owner: newOwner.getSignerAddress(),
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramId },
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
    expect(afterUpdate.deployed.feeConfig).to.exist;
    expect(afterUpdate.deployed.feeConfig?.feeProgram).to.equal(feeProgramId);
  });

  it('should upgrade a warp route whose upgrade authority is a different key', async () => {
    // Deploy legacy program owned by signer (initial upgrade authority = signer)
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
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.testIsm },
        },
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: TEST_PROGRAM_IDS.igp },
        },
        remoteRouters: {
          1: {
            address:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
        },
        destinationGas: { 1: '100000' },
      },
    });

    const programId = deployed.deployed.address;

    // Transfer warp-token ownership and BPF upgrade authority to newOwner BEFORE the upgrade
    const newOwner = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      '0x0000000000000000000000000000000000000000000000000000000000000005',
    );
    await airdropSol(rpc, address(newOwner.getSignerAddress()), 5_000_000_000n);

    const beforeTransfer = await legacyWriter.read(programId);
    const transferTxs = await legacyWriter.update({
      ...beforeTransfer,
      config: {
        ...beforeTransfer.config,
        owner: newOwner.getSignerAddress(),
      },
    });

    for (const tx of transferTxs) {
      await signer.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }
    await sleep(1000);

    // signer still has SOL to pay for the buffer but is no longer the upgrade authority.
    // This forces the SetBufferAuthority(signer → newOwner) branch in prepareProgramUpgrade.
    const upgradeWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
      },
      rpc,
      signer,
    );

    const currentAfterTransfer = await upgradeWriter.read(programId);
    const upgradeTxs = await upgradeWriter.update({
      ...currentAfterTransfer,
      config: {
        ...currentAfterTransfer.config,
        contractVersion: '1.0.0',
      },
    });

    // Returned txs (extend + upgrade) require newOwner to sign as the upgrade authority.
    for (const tx of upgradeTxs) {
      await newOwner.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }
    await sleep(1000);

    const afterUpgrade = await upgradeWriter.read(programId);
    expect(afterUpgrade.config.contractVersion).to.equal('1.0.0');
    expect(supportsFeeConfig(afterUpgrade.config.contractVersion)).to.equal(
      true,
    );
  });
});
