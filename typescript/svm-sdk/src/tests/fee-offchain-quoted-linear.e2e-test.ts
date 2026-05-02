import { address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import {
  FeeParamsType,
  FeeType,
  type OffchainQuotedLinearFeeConfig,
} from '@hyperlane-xyz/provider-sdk/fee';

import { SvmSigner } from '../clients/signer.js';
import {
  SvmOffchainQuotedLinearFeeReader,
  SvmOffchainQuotedLinearFeeWriter,
} from '../fee/offchain-quoted-linear-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';
import { defineLeafFeeTests } from './fee-leaf-suite.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const SIGNER_A = '0x1111111111111111111111111111111111111111';
const SIGNER_B = '0x2222222222222222222222222222222222222222';
const SIGNER_C = '0x3333333333333333333333333333333333333333';

describe('SVM OffchainQuotedLinear Fee E2E Tests', function () {
  this.timeout(180_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let writer: SvmOffchainQuotedLinearFeeWriter;
  let reader: SvmOffchainQuotedLinearFeeReader;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    writer = new SvmOffchainQuotedLinearFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      1,
      signer,
      DEFAULT_FEE_SALT,
    );
    reader = new SvmOffchainQuotedLinearFeeReader(rpc, DEFAULT_FEE_SALT);
  });

  // Reuse shared leaf tests (create/read, no-op update, params update, beneficiary update)
  defineLeafFeeTests<OffchainQuotedLinearFeeConfig>(() => ({
    writer,
    reader,
    signer,
    rpc,
    makeConfig: (overrides) => ({
      type: FeeType.offchainQuotedLinear,
      owner: signer.getSignerAddress(),
      beneficiary: signer.getSignerAddress(),
      params: {
        type: FeeParamsType.raw,
        maxFee: '1000000',
        halfAmount: '500000',
      },
      quoteSigners: [SIGNER_A],
      ...overrides,
    }),
  }));

  // Signer-specific tests
  it('should read back signers after create', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.offchainQuotedLinear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: { type: FeeParamsType.raw, maxFee: '100', halfAmount: '50' },
        quoteSigners: [SIGNER_A, SIGNER_B],
      },
    });

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.quoteSigners).to.have.length(2);
    expect(
      readResult.config.quoteSigners.map((s) => s.toLowerCase()),
    ).to.include.members([SIGNER_A.toLowerCase(), SIGNER_B.toLowerCase()]);
  });

  it('should add a new signer via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.offchainQuotedLinear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: { type: FeeParamsType.raw, maxFee: '100', halfAmount: '50' },
        quoteSigners: [SIGNER_A],
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: { ...deployed.config, quoteSigners: [SIGNER_A, SIGNER_B] },
    });

    expect(updateTxs).to.have.length(1);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.quoteSigners).to.have.length(2);
  });

  it('should remove a signer via update', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.offchainQuotedLinear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: { type: FeeParamsType.raw, maxFee: '100', halfAmount: '50' },
        quoteSigners: [SIGNER_A, SIGNER_B, SIGNER_C],
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: { ...deployed.config, quoteSigners: [SIGNER_A, SIGNER_C] },
    });

    expect(updateTxs).to.have.length(1);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.quoteSigners).to.have.length(2);
    expect(
      readResult.config.quoteSigners.map((s) => s.toLowerCase()),
    ).to.not.include(SIGNER_B.toLowerCase());
  });

  it('should remain offchainQuotedLinear after removing last signer', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.offchainQuotedLinear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        params: { type: FeeParamsType.raw, maxFee: '100', halfAmount: '50' },
        quoteSigners: [SIGNER_A],
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: { ...deployed.config, quoteSigners: [] },
    });

    expect(updateTxs).to.have.length(1);
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.type).to.equal(FeeType.offchainQuotedLinear);
    expect(readResult.config.quoteSigners).to.have.length(0);
  });
});
