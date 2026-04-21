import { generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { it } from 'mocha';

import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import type { SvmSigner } from '../clients/signer.js';
import type { LeafFeeConfig } from '../fee/leaf-fee.js';
import type { SvmDeployedFee } from '../fee/types.js';
import type { createRpc } from '../rpc.js';

export interface LeafFeeTestContext<T extends LeafFeeConfig['type']> {
  writer: ArtifactWriter<Extract<LeafFeeConfig, { type: T }>, SvmDeployedFee>;
  reader: ArtifactReader<Extract<LeafFeeConfig, { type: T }>, SvmDeployedFee>;
  makeConfig(
    overrides?: Partial<Omit<LeafFeeConfig, 'type'>>,
  ): Extract<LeafFeeConfig, { type: T }>;
  signer: SvmSigner;
  rpc: ReturnType<typeof createRpc>;
}

export function defineLeafFeeTests<T extends LeafFeeConfig['type']>(
  getContext: () => LeafFeeTestContext<T>,
): void {
  async function executeUpdateTxs(
    txs: Awaited<ReturnType<LeafFeeTestContext<T>['writer']['update']>>,
  ): Promise<void> {
    const { signer } = getContext();
    for (const tx of txs) {
      await signer.send({ instructions: tx.instructions });
    }
  }

  it('should create and read', async () => {
    const { writer, makeConfig, signer } = getContext();
    const config = makeConfig();

    const [deployed, receipts] = await writer.create({ config });

    expect(receipts.length).to.be.greaterThan(0);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(deployed.config.type).to.equal(config.type);
    expect(deployed.config.maxFee).to.equal(config.maxFee);
    expect(deployed.config.halfAmount).to.equal(config.halfAmount);

    const readResult = await writer.read(deployed.deployed.programId);

    expect(readResult.config.type).to.equal(config.type);
    expect(readResult.config.maxFee).to.equal(config.maxFee);
    expect(readResult.config.halfAmount).to.equal(config.halfAmount);
    expect(readResult.config.owner).to.equal(signer.getSignerAddress());
    expect(readResult.config.beneficiary).to.equal(signer.getSignerAddress());
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
        maxFee: '9999999',
        halfAmount: '4444444',
      }),
    });

    expect(updateTxs).to.have.length(1);
    await executeUpdateTxs(updateTxs);

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.maxFee).to.equal('9999999');
    expect(readResult.config.halfAmount).to.equal('4444444');
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
    await executeUpdateTxs(updateTxs);

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.beneficiary).to.equal(newBeneficiary.address);
  });
}
