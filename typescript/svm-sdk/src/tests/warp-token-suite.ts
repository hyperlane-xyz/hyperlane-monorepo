import { address, type Address } from '@solana/kit';
import { expect, it } from 'vitest';

import type { ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  RawNativeWarpArtifactConfig,
  RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { SvmSigner } from '../clients/signer.js';
import { getProgramUpgradeAuthority } from '../deploy/program-deployer.js';
import type { createRpc } from '../rpc.js';
import { airdropSol } from '../testing/setup.js';

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
  igpProgramId: Address;
  testIsmAddress: Address;
  signer: SvmSigner;
  rpc: ReturnType<typeof createRpc>;
  rpcUrl: string;
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

    expect(receipts.length).toBeGreaterThan(0);

    // Verify on-chain state via read().
    const onChain = await writer.read(deployedProgramId);
    expect(onChain.artifactState).toBe(ArtifactState.DEPLOYED);
    expect(onChain.config.mailbox).toBe(config.mailbox);
    expect(onChain.config.owner).toBe(config.owner);
    expect(onChain.config.hook).toBeUndefined();
    expect(onChain.config.interchainSecurityModule).toBeUndefined();
    expect(onChain.config.scale).toBe(testScale);
  });

  it('should deploy with IGP and ISM configured and read them back', async () => {
    const { writer, makeConfig, igpProgramId, testIsmAddress } = getContext();
    const [deployed] = await writer.create({
      config: makeConfig({
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: igpProgramId },
        },
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: testIsmAddress },
        },
      }),
    });
    deployedWithIgpAndIsmId = deployed.deployed.address;

    const token = await writer.read(deployedWithIgpAndIsmId);
    expect(token.config.hook?.deployed?.address).toBe(igpProgramId);
    expect(token.config.interchainSecurityModule?.deployed?.address).toBe(
      testIsmAddress,
    );
  });

  it('should remove IGP via update()', async () => {
    const { writer, makeConfig } = getContext();
    const current = await writer.read(deployedWithIgpAndIsmId);
    expect(current.config.hook).toBeDefined();

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig({
        interchainSecurityModule: current.config.interchainSecurityModule,
      }),
    });

    expect(updateTxs.length).toBeGreaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedWithIgpAndIsmId);
    expect(updated.config.hook).toBeUndefined();
  });

  it('should remove ISM via update()', async () => {
    const { writer, makeConfig } = getContext();
    const current = await writer.read(deployedWithIgpAndIsmId);
    expect(current.config.interchainSecurityModule).toBeDefined();

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig(),
    });

    expect(updateTxs.length).toBeGreaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedWithIgpAndIsmId);
    expect(updated.config.interchainSecurityModule).toBeUndefined();
  });

  it('should add IGP via update()', async () => {
    const { writer, makeConfig, igpProgramId } = getContext();
    const current = await writer.read(deployedProgramId);
    expect(current.config.hook).toBeUndefined();

    const updateTxs = await writer.update({
      ...current,
      config: makeConfig({
        hook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: igpProgramId },
        },
      }),
    });

    expect(updateTxs.length).toBeGreaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.hook?.deployed?.address).toBe(igpProgramId);
  });

  it('should add ISM via update()', async () => {
    const { writer, makeConfig, testIsmAddress } = getContext();
    const current = await writer.read(deployedProgramId);
    expect(current.config.interchainSecurityModule).toBeUndefined();

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

    expect(updateTxs.length).toBeGreaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.interchainSecurityModule?.deployed?.address).toBe(
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

    expect(updateTxs.length).toBeGreaterThan(0);
    await executeUpdateTxs(updateTxs);

    const updated = await writer.read(deployedProgramId);
    expect(updated.config.remoteRouters[1]?.address).toBe(
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    );
    expect(updated.config.remoteRouters[2]?.address).toBe(
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
    expect(updated.config.remoteRouters[1]).toBeDefined();
    expect(updated.config.remoteRouters[2]).toBeUndefined();
    expect(updated.config.destinationGas[2]).toBeUndefined();
  });

  it('should transfer ownership and allow new owner to update', async () => {
    const { writer, makeConfig, testIsmAddress, rpc, rpcUrl } = getContext();

    // Create a second keypair to act as the new owner.
    const newOwnerSigner = await SvmSigner.connectWithSigner(
      [rpcUrl],
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    );

    await airdropSol(
      rpc,
      address(newOwnerSigner.getSignerAddress()),
      10_000_000_000n,
    );

    // Transfer ownership to the new keypair.
    const current = await writer.read(deployedWithIgpAndIsmId);
    const transferTxs = await writer.update({
      ...current,
      config: makeConfig({ owner: newOwnerSigner.getSignerAddress() }),
    });
    expect(transferTxs.length).toBeGreaterThan(0);
    await executeUpdateTxs(transferTxs);

    const afterTransfer = await writer.read(deployedWithIgpAndIsmId);
    expect(afterTransfer.config.owner).toBe(newOwnerSigner.getSignerAddress());

    // Verify the BPF loader upgrade authority was also transferred.
    const upgradeAuthority = await getProgramUpgradeAuthority(
      rpc,
      address(deployedWithIgpAndIsmId),
    );
    expect(upgradeAuthority).toBe(newOwnerSigner.getSignerAddress());

    // New owner sets the ISM — instructions reference newOwnerSigner.address.
    const updateTxs = await writer.update({
      ...afterTransfer,
      config: makeConfig({
        owner: newOwnerSigner.getSignerAddress(),
        interchainSecurityModule: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: testIsmAddress },
        },
      }),
    });
    expect(updateTxs.length).toBeGreaterThan(0);

    for (const tx of updateTxs) {
      await newOwnerSigner.send({ instructions: tx.instructions });
    }

    const updated = await writer.read(deployedWithIgpAndIsmId);
    expect(updated.config.interchainSecurityModule?.deployed?.address).toBe(
      testIsmAddress,
    );
  });

  it('should reflect scale (remoteDecimals) correctly', async () => {
    const { writer } = getContext();
    const token = await writer.read(deployedProgramId);
    expect(token.config.scale).toBe(1e9);
  });
}
