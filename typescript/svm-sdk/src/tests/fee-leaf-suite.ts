import { generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { it } from 'mocha';

import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { FeeParamsType } from '@hyperlane-xyz/provider-sdk/fee';

import type { BaseFeeConfig, FeeParams } from '@hyperlane-xyz/provider-sdk/fee';

import type { SvmSigner } from '../clients/signer.js';
import type { SvmDeployedFee } from '../fee/types.js';
import type { createRpc } from '../rpc.js';

/** Any fee config with params — covers leaf types and offchainQuotedLinear. */
type ParamsFeeConfig = BaseFeeConfig & { type: string; params: FeeParams };

export interface LeafFeeTestContext<C extends ParamsFeeConfig> {
  writer: ArtifactWriter<C, SvmDeployedFee>;
  reader: ArtifactReader<C, SvmDeployedFee>;
  makeConfig: (overrides?: Record<string, unknown>) => C;
  signer: SvmSigner;
  rpc: ReturnType<typeof createRpc>;
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
    const config = makeConfig();

    const [deployed, receipts] = await writer.create({ config });

    expect(receipts.length).to.be.greaterThan(0);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(deployed.config.type).to.equal(config.type);

    const readResult = await writer.read(deployed.deployed.programId);
    expect(readResult.config.type).to.equal(config.type);
    expect(readResult.config.params.type).to.equal(FeeParamsType.raw);
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
    await executeUpdateTxs(updateTxs);

    const readResult = await reader.read(deployed.deployed.programId);
    expect(readResult.config.beneficiary).to.equal(newBeneficiary.address);
  });
}
