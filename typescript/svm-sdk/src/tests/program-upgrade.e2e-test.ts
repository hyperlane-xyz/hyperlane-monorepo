import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import { sleep } from '@hyperlane-xyz/utils';

import { SvmLinearFeeWriter } from '../fee/linear-fee.js';
import { deriveFeeAccountPda } from '../pda.js';

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
import { DEFAULT_FEE_SALT } from '../fee/types.js';
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
        feeSalt: DEFAULT_FEE_SALT,
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
        feeSalt: DEFAULT_FEE_SALT,
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

    // Expect 3 authority txs: extend + upgrade + SetFeeConfig(None) migration
    expect(updateTxs).to.have.length(3);
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

    // Verify SetFeeConfig works after upgrade — the whole point of upgrading
    const feeWriter = new SvmLinearFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      1,
      signer,
      DEFAULT_FEE_SALT,
    );
    const [deployedFee] = await feeWriter.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        maxFee: '1000000',
        halfAmount: '500000',
      },
    });
    const feeProgram = address(deployedFee.deployed.programId);

    const setFeeTxs = await upgradeWriter.update({
      ...afterUpgrade,
      config: {
        ...afterUpgrade.config,
        contractVersion: '1.0.0',
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgram },
        },
      },
    });
    expect(setFeeTxs).to.have.length(1);
    for (const tx of setFeeTxs) {
      await signer.send({ instructions: tx.instructions });
    }

    const withFee = await reader.read(programId);
    const expectedPda = await deriveFeeAccountPda(feeProgram, DEFAULT_FEE_SALT);
    expect(withFee.deployed.feeConfig).to.exist;
    expect(withFee.deployed.feeConfig?.feeProgram).to.equal(feeProgram);
    expect(withFee.deployed.feeConfig?.feeAccount).to.equal(
      expectedPda.address,
    );
  });

  it('should upgrade when authority differs from payer', async () => {
    // Signer A deploys with legacy bytes
    const signerA = signer;
    const legacyWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
        feeSalt: DEFAULT_FEE_SALT,
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
        feeSalt: DEFAULT_FEE_SALT,
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

    // Expect 3 authority txs: extend + upgrade + migration, all with feePayer = signerB
    expect(updateTxs).to.have.length(3);
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
        feeSalt: DEFAULT_FEE_SALT,
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
        feeSalt: DEFAULT_FEE_SALT,
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

  it('should fail ownership transfer after upgrade without SetFeeConfig(None) migration', async () => {
    // Deploy with legacy bytes
    const legacyWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
        feeSalt: DEFAULT_FEE_SALT,
      },
      rpc,
      signer,
    );

    // Deploy with ALL optional fields set (ISM, IGP, routers, gas) to maximize
    // serialized size. When every Option is Some, the serialized data fills the
    // allocated buffer exactly — leaving no room for the 1-byte fee_config tag
    // that the new binary writes.
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

    // Upgrade to new version
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
    const upgradeTxs = await upgradeWriter.update({
      ...current,
      config: {
        ...current.config,
        contractVersion: '1.0.0',
      },
    });

    // Remove the last tx (SetFeeConfig(None) migration) to simulate a partial
    // upgrade. prepareProgramUpgrade always appends the migration tx last.
    upgradeTxs.pop();
    for (const tx of upgradeTxs) {
      await signer.send({
        instructions: tx.instructions,
        additionalSigners: tx.additionalSigners,
        skipPreflight: true,
      });
    }
    await sleep(1000);

    // Ownership transfer WITHOUT SetFeeConfig(None) migration fails.
    // The new binary serializes fee_config: None (1 extra byte) but
    // transfer_ownership uses store(account, false) — no realloc.
    // When all optional fields are Some, the buffer is exactly full
    // and the extra byte causes BorshIoError.
    const newOwner = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      '0x0000000000000000000000000000000000000000000000000000000000000003',
    );
    await airdropSol(rpc, address(newOwner.getSignerAddress()), 5_000_000_000n);

    const afterUpgrade = await upgradeWriter.read(programId);
    const ownershipTxs = await upgradeWriter.update({
      ...afterUpgrade,
      config: {
        ...afterUpgrade.config,
        contractVersion: '1.0.0',
        owner: newOwner.getSignerAddress(),
      },
    });

    expect(ownershipTxs.length).to.be.greaterThan(0);
    try {
      for (const tx of ownershipTxs) {
        await signer.send({
          instructions: tx.instructions,
          additionalSigners: tx.additionalSigners,
        });
      }
      expect.fail('Should have failed without SetFeeConfig(None) migration');
    } catch (e: unknown) {
      // BorshIoError surfaces in the cause chain as
      // "Failed to serialize or deserialize account data".
      const cause = (e as { cause?: { message?: string } }).cause;
      expect(cause?.message).to.include('serialize or deserialize');
    }
  });

  it('should succeed ownership transfer after upgrade with migration', async () => {
    // Same setup as the failing test — legacy deploy with all options filled.
    const legacyWriter = new SvmCollateralTokenWriter(
      {
        program: { programBytes: LEGACY_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
        feeSalt: DEFAULT_FEE_SALT,
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

    // Upgrade + migration + ownership transfer — all txs included
    const allTxs = await upgradeWriter.update({
      ...current,
      config: {
        ...current.config,
        contractVersion: '1.0.0',
        owner: newOwner.getSignerAddress(),
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
  });
});
