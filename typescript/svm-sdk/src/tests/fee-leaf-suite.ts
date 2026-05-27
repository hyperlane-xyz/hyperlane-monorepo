import { address, generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { it } from 'mocha';

import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { FeeParamsType } from '@hyperlane-xyz/provider-sdk/fee';

import type { BaseFeeConfig, FeeParams } from '@hyperlane-xyz/provider-sdk/fee';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import type { SvmDeployedFee } from '../fee/types.js';
import { deriveAssociatedTokenAddress } from '../pda.js';
import type { createRpc } from '../rpc.js';
import { airdropSol, createSplMint } from '../testing/setup.js';

/** Any fee config with params — covers leaf types and offchainQuotedLinear. */
type ParamsFeeConfig = BaseFeeConfig & { type: string; params: FeeParams };

export interface LeafFeeTestContext<C extends ParamsFeeConfig> {
  writer: ArtifactWriter<C, SvmDeployedFee>;
  reader: ArtifactReader<C, SvmDeployedFee>;
  makeConfig: (overrides?: Record<string, unknown>) => C;
  makeWriter: (signer: SvmSigner) => ArtifactWriter<C, SvmDeployedFee>;
  signer: SvmSigner;
  rpc: ReturnType<typeof createRpc>;
  rpcUrl: string;
}

export function defineLeafFeeTests<C extends ParamsFeeConfig>(
  getContext: () => LeafFeeTestContext<C>,
): void {
  async function executeUpdateTxs(
    txs: Awaited<ReturnType<LeafFeeTestContext<C>['writer']['update']>>,
  ): Promise<void> {
    const { signer } = getContext();
    for (const tx of txs) {
      await signer.send({ instructions: tx.instructions });
    }
  }

  it('should create and read', async () => {
    const { writer, signer, makeConfig } = getContext();
    const owner = await generateKeyPairSigner();
    const config = makeConfig({ owner: owner.address });

    const [deployed, receipts] = await writer.create({ config });

    expect(receipts.length).to.be.greaterThan(0);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(deployed.config.type).to.equal(config.type);

    const readResult = await writer.read(deployed.deployed.programId);
    expect(readResult.config.type).to.equal(config.type);
    expect(readResult.config.params.type).to.equal(FeeParamsType.raw);
    expect(readResult.config.owner).to.equal(owner.address);
    expect(readResult.config.beneficiary).to.equal(signer.getSignerAddress());
  });

  it('should create beneficiary ATA at fee deploy when token is set', async () => {
    const { writer, signer, rpc, makeConfig } = getContext();

    const mint = await createSplMint(rpc, signer, 9);
    const beneficiary = await generateKeyPairSigner();
    const config = makeConfig({
      beneficiary: beneficiary.address,
      token: mint,
    });

    const [deployed] = await writer.create({ config });

    const expectedAta = await deriveAssociatedTokenAddress({
      wallet: beneficiary.address,
      mint,
    });
    const ataInfo = await rpc
      .getAccountInfo(expectedAta.address, { encoding: 'base64' })
      .send();
    expect(ataInfo.value).to.not.be.null;

    // Re-reading and re-running update should be a no-op since the ATA is
    // already in place and no other fields changed.
    const followupTxs = await writer.update({
      ...deployed,
      config,
    });
    expect(followupTxs).to.have.length(0);
  });

  it('should return empty transactions when config is unchanged', async () => {
    const { writer, makeConfig } = getContext();
    const [deployed] = await writer.create({ config: makeConfig() });
    const updateTxs = await writer.update(deployed);
    expect(updateTxs).to.have.length(0);
  });

  it('should update fee params', async () => {
    const { writer, reader, makeConfig } = getContext();
    const [deployed] = await writer.create({ config: makeConfig() });

    const updateTxs = await writer.update({
      ...deployed,
      config: makeConfig({
        params: {
          type: FeeParamsType.raw,
          maxFee: '9999999',
          halfAmount: '4444444',
        },
      }),
    });

    expect(updateTxs).to.have.length(1);
    await executeUpdateTxs(updateTxs);

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.params.maxFee).to.equal('9999999');
    expect(readResult.config.params.halfAmount).to.equal('4444444');
  });

  it('should update beneficiary', async () => {
    const { writer, reader, makeConfig } = getContext();
    const [deployed] = await writer.create({ config: makeConfig() });

    const newBeneficiary = await generateKeyPairSigner();
    const updateTxs = await writer.update({
      ...deployed,
      config: makeConfig({ beneficiary: newBeneficiary.address }),
    });

    expect(updateTxs).to.have.length(1);
    const [updateTx] = updateTxs;
    assert(updateTx, 'expected one update tx');
    expect(updateTx.instructions).to.have.length(1);
    await executeUpdateTxs(updateTxs);

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.beneficiary).to.equal(newBeneficiary.address);
  });

  it('should create beneficiary ATA when token is introduced without beneficiary change', async () => {
    const { writer, reader, signer, rpc, makeConfig } = getContext();
    const [deployed] = await writer.create({ config: makeConfig() });

    const mint = await createSplMint(rpc, signer, 9);
    const updateTxs = await writer.update({
      ...deployed,
      config: makeConfig({ token: mint }),
    });

    // Standalone ATA-create tx (beneficiary unchanged, token now set).
    expect(updateTxs).to.have.length(1);
    const [updateTx] = updateTxs;
    assert(updateTx, 'expected one update tx');
    expect(updateTx.instructions).to.have.length(1);
    await executeUpdateTxs(updateTxs);

    const readResult = await reader.read(deployed.deployed.programId);
    const expectedAta = await deriveAssociatedTokenAddress({
      wallet: address(readResult.config.beneficiary),
      mint,
    });
    const ataInfo = await rpc
      .getAccountInfo(expectedAta.address, { encoding: 'base64' })
      .send();
    expect(ataInfo.value).to.not.be.null;

    // Re-running update with the same (token, beneficiary) is a no-op since
    // the ATA already exists.
    const followupTxs = await writer.update({
      ...deployed,
      config: makeConfig({ token: mint }),
    });
    expect(followupTxs).to.have.length(0);
  });

  it('should update beneficiary and create ATA when token is set', async () => {
    const { writer, reader, signer, rpc, makeConfig } = getContext();
    const [deployed] = await writer.create({ config: makeConfig() });

    const mint = await createSplMint(rpc, signer, 9);
    const newBeneficiary = await generateKeyPairSigner();
    const updateTxs = await writer.update({
      ...deployed,
      config: makeConfig({ beneficiary: newBeneficiary.address, token: mint }),
    });

    expect(updateTxs).to.have.length(1);
    const [updateTx] = updateTxs;
    assert(updateTx, 'expected one update tx');
    // ATA-idempotent ix prepended to the SetBeneficiary ix in the same tx.
    expect(updateTx.instructions).to.have.length(2);
    await executeUpdateTxs(updateTxs);

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.beneficiary).to.equal(newBeneficiary.address);

    const expectedAta = await deriveAssociatedTokenAddress({
      wallet: newBeneficiary.address,
      mint,
    });
    const ataInfo = await rpc
      .getAccountInfo(expectedAta.address, { encoding: 'base64' })
      .send();
    expect(ataInfo.value).to.not.be.null;
  });

  it('should transfer ownership and new owner can update', async () => {
    const { writer, reader, rpc, rpcUrl, makeConfig, makeWriter } =
      getContext();
    const [deployed] = await writer.create({ config: makeConfig() });

    // Create a new owner signer and fund it
    const newOwnerKey =
      '0x0000000000000000000000000000000000000000000000000000000000000002';
    const newOwnerSigner = await SvmSigner.connectWithSigner(
      [rpcUrl],
      newOwnerKey,
    );
    await airdropSol(
      rpc,
      address(newOwnerSigner.getSignerAddress()),
      10_000_000_000n,
    );

    // Transfer ownership from original signer to new owner
    const transferTxs = await writer.update({
      ...deployed,
      config: makeConfig({ owner: newOwnerSigner.getSignerAddress() }),
    });
    expect(transferTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(transferTxs);

    const afterTransfer = await reader.read(deployed.deployed.programId);
    expect(afterTransfer.config.owner).to.equal(
      newOwnerSigner.getSignerAddress(),
    );

    // New owner updates fee params using a writer backed by the new signer
    const newOwnerWriter = makeWriter(newOwnerSigner);
    const paramUpdateTxs = await newOwnerWriter.update({
      ...deployed,
      config: makeConfig({
        owner: newOwnerSigner.getSignerAddress(),
        params: {
          type: FeeParamsType.raw,
          maxFee: '7777777',
          halfAmount: '3333333',
        },
      }),
    });
    expect(paramUpdateTxs.length).to.be.greaterThan(0);
    for (const tx of paramUpdateTxs) {
      await newOwnerSigner.send({ instructions: tx.instructions });
    }

    const afterUpdate = await reader.read(deployed.deployed.programId);
    expect(afterUpdate.config.params.maxFee).to.equal('7777777');
    expect(afterUpdate.config.params.halfAmount).to.equal('3333333');
  });
}
