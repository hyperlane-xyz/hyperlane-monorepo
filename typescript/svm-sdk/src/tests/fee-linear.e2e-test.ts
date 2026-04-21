import { expect } from 'chai';
import { before, describe, it } from 'mocha';
import { address, generateKeyPairSigner } from '@solana/kit';

import { FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';
import { SvmLinearFeeReader, SvmLinearFeeWriter } from '../fee/linear-fee.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Linear Fee E2E Tests', function () {
  this.timeout(180_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let writer: SvmLinearFeeWriter;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    await airdropSol(rpc, address(signer.getSignerAddress()), 100_000_000_000n);

    writer = new SvmLinearFeeWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee } },
      rpc,
      1,
      signer,
    );
  });

  it('should create and read a linear fee', async () => {
    const [deployed, receipts] = await writer.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        maxFee: '1000000',
        halfAmount: '500000',
      },
    });

    expect(receipts.length).to.be.greaterThan(0);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(deployed.config.type).to.equal(FeeType.linear);
    expect(deployed.config.maxFee).to.equal('1000000');
    expect(deployed.config.halfAmount).to.equal('500000');

    const reader = new SvmLinearFeeReader(rpc);
    const readResult = await reader.read(deployed.deployed.programId);

    expect(readResult.config.type).to.equal(FeeType.linear);
    expect(readResult.config.maxFee).to.equal('1000000');
    expect(readResult.config.halfAmount).to.equal('500000');
    expect(readResult.config.owner).to.equal(signer.getSignerAddress());
    expect(readResult.config.beneficiary).to.equal(signer.getSignerAddress());
  });

  it('should return empty transactions when config is unchanged', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        maxFee: '100',
        halfAmount: '50',
      },
    });

    const updateTxs = await writer.update(deployed);
    expect(updateTxs).to.have.length(0);
  });

  it('should update fee params', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        maxFee: '1000000',
        halfAmount: '500000',
      },
    });

    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        maxFee: '2000000',
        halfAmount: '750000',
      },
    });

    expect(updateTxs).to.have.length(1);

    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmLinearFeeReader(rpc);
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.maxFee).to.equal('2000000');
    expect(readResult.config.halfAmount).to.equal('750000');
  });

  it('should update beneficiary', async () => {
    const [deployed] = await writer.create({
      config: {
        type: FeeType.linear,
        owner: signer.getSignerAddress(),
        beneficiary: signer.getSignerAddress(),
        maxFee: '100',
        halfAmount: '50',
      },
    });

    const newBeneficiary = await generateKeyPairSigner();
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        beneficiary: newBeneficiary.address,
      },
    });

    expect(updateTxs).to.have.length(1);

    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const reader = new SvmLinearFeeReader(rpc);
    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.beneficiary).to.equal(newBeneficiary.address);
  });
});
