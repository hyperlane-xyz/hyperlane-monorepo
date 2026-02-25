import type { Address } from '@solana/kit';
import { expect } from 'chai';
import { it } from 'mocha';

import type { ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  RawNativeWarpArtifactConfig,
  RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { createSigner, type SvmSigner } from '../signer.js';
import { airdropSol } from '../testing/setup.js';
import type { SvmRpc } from '../types.js';

/**
 * Overrides that can be applied to any token type config.
 * Excludes the `type` discriminant — each test provides its own fixed type.
 */
export type WarpConfigOverrides = Partial<
  Omit<RawNativeWarpArtifactConfig, 'type'>
>;

export interface WarpTestContext {
  writer: ArtifactWriter<RawWarpArtifactConfig, DeployedWarpAddress>;
  makeConfig(overrides?: WarpConfigOverrides): RawWarpArtifactConfig;
  overheadIgpAccountAddress: Address;
  testIsmAddress: Address;
  signer: SvmSigner & { address: Address };
  rpc: SvmRpc;
}

/**
 * Registers the shared warp token test suite inside the calling describe() block.
 * Calls onDeployedProgramId with the address from the first deploy test so
 * token-specific tests in the calling file can capture it via closure.
 */
export function defineWarpTokenTests(
  getContext: () => WarpTestContext,
  onDeployedProgramId: (id: string) => void,
): void {
  let deployedProgramId: string;
  let deployedWithIgpAndIsmId: string;

  async function executeUpdateTxs(
    txs: Awaited<ReturnType<WarpTestContext['writer']['update']>>,
  ): Promise<void> {
    const { signer } = getContext();
    for (const tx of txs) {
      await signer.send({ instructions: tx.instructions });
    }
  }

  it('should deploy and initialize token', async () => {
    const { writer, makeConfig } = getContext();
    const testScale = 1e9;
    const config = makeConfig({ scale: testScale });
    const [deployed, receipts] = await writer.create({ config });

    deployedProgramId = deployed.deployed.address;
    onDeployedProgramId(deployedProgramId);

    expect(receipts.length).to.be.greaterThan(0);

    // Verify on-chain state via read().
    const onChain = await writer.read(deployedProgramId);
    expect(onChain.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(onChain.config.mailbox).to.equal(config.mailbox);
    expect(onChain.config.owner).to.equal(config.owner);
    expect(onChain.config.hook).to.be.undefined;
    expect(onChain.config.interchainSecurityModule).to.be.undefined;
    expect(onChain.config.scale).to.equal(testScale);
  });

  it('should deploy with IGP and ISM configured and read them back', async () => {
    const { writer, makeConfig, overheadIgpAccountAddress, testIsmAddress } =
      getContext();
    const [deployed] = await writer.create({
      config: makeConfig({
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: overheadIgpAccountAddress },
        },
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: testIsmAddress },
        },
      }),
    });
    deployedWithIgpAndIsmId = deployed.deployed.address;

    const token = await writer.read(deployedWithIgpAndIsmId);
    expect(token.config.hook?.deployed?.address).to.equal(
      overheadIgpAccountAddress,
    );
    expect(token.config.interchainSecurityModule?.deployed?.address).to.equal(
      testIsmAddress,
    );
  });

  it('should remove IGP via update()', async () => {
    const { writer, makeConfig } = getContext();
    const current = await writer.read(deployedWithIgpAndIsmId);
    expect(current.config.hook).to.exist;

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig({
        interchainSecurityModule: current.config.interchainSecurityModule,
      }),
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedWithIgpAndIsmId);
    expect(updated.config.hook).to.be.undefined;
  });

  it('should remove ISM via update()', async () => {
    const { writer, makeConfig } = getContext();
    const current = await writer.read(deployedWithIgpAndIsmId);
    expect(current.config.interchainSecurityModule).to.exist;

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig(),
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedWithIgpAndIsmId);
    expect(updated.config.interchainSecurityModule).to.be.undefined;
  });

  it('should add IGP via update()', async () => {
    const { writer, makeConfig, overheadIgpAccountAddress } = getContext();
    const current = await writer.read(deployedProgramId);
    expect(current.config.hook).to.be.undefined;

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig({
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: overheadIgpAccountAddress },
        },
      }),
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.hook?.deployed?.address).to.equal(
      overheadIgpAccountAddress,
    );
  });

  it('should add ISM via update()', async () => {
    const { writer, makeConfig, testIsmAddress } = getContext();
    const current = await writer.read(deployedProgramId);
    expect(current.config.interchainSecurityModule).to.be.undefined;

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig({
        hook: current.config.hook,
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: testIsmAddress },
        },
      }),
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.interchainSecurityModule?.deployed?.address).to.equal(
      testIsmAddress,
    );
  });

  it('should enroll remote routers', async () => {
    const { writer, makeConfig } = getContext();
    const current = await writer.read(deployedProgramId);

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig({
        hook: current.config.hook,
        interchainSecurityModule: current.config.interchainSecurityModule,
        remoteRouters: {
          1: {
            address:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
          2: {
            address:
              '0x2222222222222222222222222222222222222222222222222222222222222222',
          },
        },
        destinationGas: { 1: '100000', 2: '200000' },
      }),
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.remoteRouters[1]?.address).to.equal(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    );
    expect(updated.config.remoteRouters[2]?.address).to.equal(
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    );
  });

  it('should unenroll routers', async () => {
    const { writer, makeConfig } = getContext();
    const current = await writer.read(deployedProgramId);

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig({
        hook: current.config.hook,
        interchainSecurityModule: current.config.interchainSecurityModule,
        remoteRouters: { 1: current.config.remoteRouters[1] },
        destinationGas: { 1: current.config.destinationGas[1] },
      }),
    });

    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.remoteRouters[1]).to.exist;
    expect(updated.config.remoteRouters[2]).to.be.undefined;
  });

  it('should transfer ownership and allow new owner to update', async () => {
    const { writer, makeConfig, testIsmAddress, rpc } = getContext();

    // Create a second keypair to act as the new owner.
    const newOwnerSigner = await createSigner(
      '0x0000000000000000000000000000000000000000000000000000000000000002',
      rpc,
    );
    await airdropSol(rpc, newOwnerSigner.address, 10_000_000_000n);

    // Transfer ownership to the new keypair.
    const current = await writer.read(deployedProgramId);
    const transferTxs = await writer.update({
      ...current,
      config: makeConfig({ owner: newOwnerSigner.address }),
    });
    expect(transferTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(transferTxs);

    const afterTransfer = await writer.read(deployedProgramId);
    expect(afterTransfer.config.owner).to.equal(newOwnerSigner.address);

    // New owner sets the ISM — instructions reference newOwnerSigner.address.
    const updateTxs = await writer.update({
      ...afterTransfer,
      config: makeConfig({
        owner: newOwnerSigner.address,
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: testIsmAddress },
        },
      }),
    });
    expect(updateTxs.length).to.be.greaterThan(0);

    for (const tx of updateTxs) {
      await newOwnerSigner.send({ instructions: tx.instructions });
    }

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.interchainSecurityModule?.deployed?.address).to.equal(
      testIsmAddress,
    );
  });

  it('should reflect scale (remoteDecimals) correctly', async () => {
    const { writer } = getContext();
    const token = await writer.read(deployedProgramId);
    expect(token.config.scale).to.equal(1e9);
  });
}
