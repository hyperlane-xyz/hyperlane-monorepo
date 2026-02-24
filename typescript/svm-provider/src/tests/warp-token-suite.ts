import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { expect } from 'chai';
import { it } from 'mocha';

import type { ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import type { SvmSigner } from '../signer.js';

export interface WarpTestContext {
  writer: ArtifactWriter<RawWarpArtifactConfig, DeployedWarpAddress>;
  /**
   * Builds the full token config, merging the given overrides on top of the
   * token-type-specific base fields (type, owner, mailbox, etc.).
   */
  makeConfig(overrides?: Partial<RawWarpArtifactConfig>): RawWarpArtifactConfig;
  overheadIgpAccountAddress: Address;
  testIsmAddress: Address;
  signer: SvmSigner;
  rpc: Rpc<SolanaRpcApi>;
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
    const { signer, rpc } = getContext();
    for (const tx of txs) {
      for (const ix of tx.instructions) {
        await signer.signAndSend(rpc, { instructions: [ix] });
      }
    }
  }

  it('should deploy and initialize token', async () => {
    const { writer, makeConfig } = getContext();
    const [deployed, receipts] = await writer.create({
      config: makeConfig(),
    });
    deployedProgramId = deployed.deployed.address;
    onDeployedProgramId(deployedProgramId);
    expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
    expect(deployed.deployed.address).to.be.a('string');
    expect(receipts.length).to.be.greaterThan(0);
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

    // Preserve ISM, clear hook by omitting it
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

    // No overrides — hook already cleared, ISM omitted to clear it
    const updateTxs = await writer.update({
      ...current,
      config: makeConfig(),
    });

    expect(updateTxs.length).to.be.greaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedWithIgpAndIsmId);
    expect(updated.config.interchainSecurityModule).to.be.undefined;
  });

  it('should update IGP via update()', async () => {
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

  it('should update ISM via update()', async () => {
    const { writer, makeConfig, testIsmAddress } = getContext();
    const current = await writer.read(deployedProgramId);
    expect(current.config.interchainSecurityModule).to.be.undefined;

    // Preserve current IGP while setting ISM
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

    // Preserve current hook/ISM while setting routers
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

    // Preserve hook/ISM and keep only router 1
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
}
