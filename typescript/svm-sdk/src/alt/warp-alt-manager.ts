import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import type { ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  WarpArtifactConfigs,
  WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { createRpc } from '../rpc.js';
import type { SvmRpc } from '../types.js';

import {
  SvmAddressLookupTableReader,
  SvmAddressLookupTableWriter,
  type SvmAltConfig,
  type SvmDeployedAlt,
} from './address-lookup-table.js';
import { SvmCollateralTokenAltWriter } from './collateral-token-alt-writer.js';
import { SvmCrossCollateralTokenAltWriter } from './cross-collateral-token-alt-writer.js';
import { SvmNativeTokenAltWriter } from './native-token-alt-writer.js';
import { SvmSyntheticTokenAltWriter } from './synthetic-token-alt-writer.js';
import type { SvmTokenAltWriter } from './warp-alt.js';

/**
 * Dispatches to the correct per-token-type ALT writer based on the
 * `WarpType` of the warp route being managed. Mirrors the
 * `SvmWarpArtifactManager.createWriter(type)` pattern: callers pass
 * the warp type they're working with and receive a writer typed to
 * that variant.
 */
export class SvmWarpAltManager {
  constructor(
    private readonly chainName: string,
    private readonly rpc: SvmRpc,
    private readonly altWriter: SvmAddressLookupTableWriter,
  ) {}

  createWriter<T extends WarpType>(
    type: T,
  ): SvmTokenAltWriter<WarpArtifactConfigs[T]> {
    const writers: {
      [K in WarpType]: () => SvmTokenAltWriter<WarpArtifactConfigs[K]>;
    } = {
      native: () => new SvmNativeTokenAltWriter(this.chainName, this.altWriter),
      collateral: () =>
        new SvmCollateralTokenAltWriter(
          this.chainName,
          this.rpc,
          this.altWriter,
        ),
      synthetic: () =>
        new SvmSyntheticTokenAltWriter(this.chainName, this.altWriter),
      crossCollateral: () =>
        new SvmCrossCollateralTokenAltWriter(
          this.chainName,
          this.rpc,
          this.altWriter,
        ),
    };

    return writers[type]();
  }
}

/**
 * Public factory for building an `SvmWarpAltManager` from chain
 * metadata and a signer. Hides the RPC + ALT-writer wiring behind a
 * one-liner so package consumers don't need to construct the internal
 * components themselves.
 */
export function createWarpAltManager(
  chainMetadata: ChainMetadataForAltVM,
  signer: SvmSigner,
): SvmWarpAltManager {
  assert(
    chainMetadata.rpcUrls && chainMetadata.rpcUrls.length > 0,
    'At least one RPC URL is required',
  );
  const rpc = createRpc(chainMetadata.rpcUrls[0].http);
  const altWriter = new SvmAddressLookupTableWriter(rpc, signer);
  return new SvmWarpAltManager(chainMetadata.name, rpc, altWriter);
}

/**
 * Read-only counterpart to `SvmWarpAltManager`. Exposes just the
 * `read` surface so consumers that only need to inspect on-chain ALT
 * contents (e.g. `warp alt read` in the CLI) don't have to supply a
 * signer.
 */
export class SvmWarpAltReader {
  constructor(private readonly altReader: SvmAddressLookupTableReader) {}

  async read(addresses: { core: string; warpSpecific: string[] }): Promise<{
    core: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>;
    warpSpecific: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>[];
  }> {
    const core = await this.altReader.read(addresses.core);
    const warpSpecific = await Promise.all(
      addresses.warpSpecific.map((addr) => this.altReader.read(addr)),
    );
    return { core, warpSpecific };
  }
}

/**
 * Public factory for an `SvmWarpAltReader` from chain metadata —
 * no signer required.
 */
export function createWarpAltReader(
  chainMetadata: ChainMetadataForAltVM,
): SvmWarpAltReader {
  assert(
    chainMetadata.rpcUrls && chainMetadata.rpcUrls.length > 0,
    'At least one RPC URL is required',
  );
  const rpc = createRpc(chainMetadata.rpcUrls[0].http);
  return new SvmWarpAltReader(new SvmAddressLookupTableReader(rpc));
}
