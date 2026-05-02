import { address } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { FeeParamsType, FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { SvmSigner } from '../clients/signer.js';
import { SvmLinearFeeReader, SvmLinearFeeWriter } from '../fee/linear-fee.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

describe('SVM Linear Fee E2E Tests', function () {
  this.timeout(180_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let writer: SvmLinearFeeWriter;
  let reader: SvmLinearFeeReader;

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
      DEFAULT_FEE_SALT,
    );
    reader = new SvmLinearFeeReader(rpc, DEFAULT_FEE_SALT);
  });

  it('should create and read linear fee', async () => {
    const [deployed, receipts] = await writer.create({
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

    expect(receipts.length).to.be.greaterThan(0);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(deployed.config.type).to.equal(FeeType.linear);

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.type).to.equal(FeeType.linear);
    expect(readResult.config.params.type).to.equal(FeeParamsType.raw);
    expect(readResult.config.params.maxFee).to.equal('1000000');
    expect(readResult.config.params.halfAmount).to.equal('500000');
  });

  it('should update fee params', async () => {
    const [deployed] = await writer.create({
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

    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        params: {
          type: FeeParamsType.raw,
          maxFee: '2000000',
          halfAmount: '1000000',
        },
      },
    });

    expect(updateTxs).to.have.length(1);
    expect(updateTxs[0]!.annotation).to.include('params');

    // Apply the update
    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.params.maxFee).to.equal('2000000');
    expect(readResult.config.params.halfAmount).to.equal('1000000');
  });

  it('should update beneficiary', async () => {
    const [deployed] = await writer.create({
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

    const newBeneficiary = '11111111111111111111111111111111';
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        beneficiary: newBeneficiary,
      },
    });

    expect(updateTxs).to.have.length(1);
    expect(updateTxs[0]!.annotation).to.include('beneficiary');

    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.beneficiary).to.equal(newBeneficiary);
  });

  it('should transfer ownership', async () => {
    const [deployed] = await writer.create({
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

    // Use a real non-zero address for the new owner
    const newOwner = 'BKgwCR5236gFohQcS3LGFjGPjKYXGwHxS1YSfa7cqw11';
    const updateTxs = await writer.update({
      ...deployed,
      config: {
        ...deployed.config,
        owner: newOwner,
      },
    });

    expect(updateTxs).to.have.length(1);
    expect(updateTxs[0]!.annotation).to.include('ownership');

    for (const tx of updateTxs) {
      await signer.send(tx);
    }

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.owner).to.equal(newOwner);
  });
});
