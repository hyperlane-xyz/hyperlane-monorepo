import { address, type Address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { FeeParamsType, FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';
import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';

import { SvmSigner } from '../clients/signer.js';
import { SvmLinearFeeWriter } from '../fee/linear-fee.js';
import { DEFAULT_FEE_SALT, deriveFeeSalt } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { DEFAULT_IGP_SALT, SvmIgpHookWriter } from '../hook/igp-hook.js';
import { deriveFeeAccountPda } from '../pda.js';
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

const ALTERNATE_SALT = deriveFeeSalt('alternate-salt');

const rawParams = {
  type: FeeParamsType.raw,
  maxFee: '1000000',
  halfAmount: '500000',
} as const;

describe('SVM Warp Fee Config E2E Tests', function () {
  this.timeout(300_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let mailboxAddress: Address;
  let collateralMint: Address;
  let feeProgramA: Address;
  let feeProgramB: Address;

  function makeWriter(feeSalt: Uint8Array = DEFAULT_FEE_SALT) {
    return new SvmCollateralTokenWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral },
        ataPayerFundingAmount: TEST_ATA_PAYER_FUNDING_AMOUNT,
        feeSalt,
      },
      rpc,
      signer,
    );
  }

  async function deployFee(salt: Uint8Array): Promise<Address> {
    const feeWriter = new SvmLinearFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      1,
      signer,
      salt,
    );
    const [deployed] = await feeWriter.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: rawParams,
      },
    });
    return address(deployed.deployed.programId);
  }

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);
    mailboxAddress = TEST_PROGRAM_IDS.mailbox;
    collateralMint = await createSplMint(rpc, signer, 9);

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

    feeProgramA = await deployFee(DEFAULT_FEE_SALT);
    feeProgramB = await deployFee(DEFAULT_FEE_SALT);

    // Init another fee account on feeProgramA with alternate salt for salt-change test
    const altFeeWriter = new SvmLinearFeeWriter(
      { program: { programId: feeProgramA } },
      rpc,
      1,
      signer,
      ALTERNATE_SALT,
    );
    await altFeeWriter.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: rawParams,
      },
    });
  });

  it('should set fee on deployment', async () => {
    const writer = makeWriter();
    const [deployed] = await writer.create({
      config: {
        type: TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramA },
        },
      },
    });

    const onChain = await new SvmCollateralTokenReader(rpc).read(
      deployed.deployed.address,
    );
    const expectedPda = await deriveFeeAccountPda(
      feeProgramA,
      DEFAULT_FEE_SALT,
    );

    expect(onChain.deployed.feeConfig).to.exist;
    expect(onChain.deployed.feeConfig?.feeProgram).to.equal(feeProgramA);
    expect(onChain.deployed.feeConfig?.feeAccount).to.equal(
      expectedPda.address,
    );
  });

  it('should add fee via update when none was set', async () => {
    const writer = makeWriter();
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
    expect(current.deployed.feeConfig).to.be.undefined;

    const updateTxs = await writer.update({
      ...current,
      config: {
        ...current.config,
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramA },
        },
      },
    });

    expect(updateTxs).to.have.length(1);
    for (const tx of updateTxs) {
      await signer.send({ instructions: tx.instructions });
    }

    const afterUpdate = await writer.read(deployed.deployed.address);
    expect(afterUpdate.deployed.feeConfig?.feeProgram).to.equal(feeProgramA);
  });

  it('should change from one fee program to another', async () => {
    const writer = makeWriter();
    const [deployed] = await writer.create({
      config: {
        type: TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramA },
        },
      },
    });

    const current = await writer.read(deployed.deployed.address);
    expect(current.deployed.feeConfig?.feeProgram).to.equal(feeProgramA);

    const updateTxs = await writer.update({
      ...current,
      config: {
        ...current.config,
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramB },
        },
      },
    });

    expect(updateTxs).to.have.length(1);
    for (const tx of updateTxs) {
      await signer.send({ instructions: tx.instructions });
    }

    const afterUpdate = await writer.read(deployed.deployed.address);
    expect(afterUpdate.deployed.feeConfig?.feeProgram).to.equal(feeProgramB);
  });

  it('should detect fee account change when same program but different salt', async () => {
    const writer = makeWriter(DEFAULT_FEE_SALT);
    const [deployed] = await writer.create({
      config: {
        type: TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramA },
        },
      },
    });

    const current = await writer.read(deployed.deployed.address);
    const defaultPda = await deriveFeeAccountPda(feeProgramA, DEFAULT_FEE_SALT);
    expect(current.deployed.feeConfig?.feeAccount).to.equal(defaultPda.address);

    // Update with alternate salt — same program but different fee account PDA
    const altWriter = makeWriter(ALTERNATE_SALT);
    const updateTxs = await altWriter.update({
      ...current,
      config: {
        ...current.config,
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramA },
        },
      },
    });

    expect(updateTxs).to.have.length(1);
    for (const tx of updateTxs) {
      await signer.send({ instructions: tx.instructions });
    }

    const afterUpdate = await altWriter.read(deployed.deployed.address);
    const altPda = await deriveFeeAccountPda(feeProgramA, ALTERNATE_SALT);
    expect(afterUpdate.deployed.feeConfig?.feeProgram).to.equal(feeProgramA);
    expect(afterUpdate.deployed.feeConfig?.feeAccount).to.equal(altPda.address);
    expect(afterUpdate.deployed.feeConfig?.feeAccount).to.not.equal(
      defaultPda.address,
    );
  });

  it('should remove fee via update', async () => {
    const writer = makeWriter();
    const [deployed] = await writer.create({
      config: {
        type: TokenType.collateral,
        owner: signer.getSignerAddress(),
        mailbox: mailboxAddress,
        token: collateralMint,
        remoteRouters: {},
        destinationGas: {},
        fee: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: feeProgramA },
        },
      },
    });

    const current = await writer.read(deployed.deployed.address);
    expect(current.deployed.feeConfig).to.exist;

    const updateTxs = await writer.update({
      ...current,
      config: {
        ...current.config,
        fee: undefined,
      },
    });

    expect(updateTxs).to.have.length(1);
    for (const tx of updateTxs) {
      await signer.send({ instructions: tx.instructions });
    }

    const afterUpdate = await writer.read(deployed.deployed.address);
    expect(afterUpdate.deployed.feeConfig).to.be.undefined;
  });
});
