import { type Address, address as parseAddress } from '@solana/kit';

import { type ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type NativeWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveNativeCollateralPda,
} from '../pda.js';
import type { SvmReceipt, SvmRpc } from '../types.js';

import { type SvmAddressLookupTableWriter } from './address-lookup-table.js';
import {
  type AnnotatedAltAddress,
  type SvmTokenAltWriter,
  SvmTokenAltReaderBase,
  canonicalize,
  createWarpAltsImpl,
  deriveWarpRouteCommonAltAddresses,
} from './warp-alt.js';

/**
 * Read-only ALT surface for a native SVM warp route. Owns the
 * warp-route address derivation; shared `read` / `check` /
 * `computeExpectedAltAddresses` come from `SvmTokenAltReaderBase`.
 *
 * The companion `SvmNativeTokenAltWriter` extends this and adds
 * `create`.
 */
export class SvmNativeTokenAltReader extends SvmTokenAltReaderBase<NativeWarpArtifactConfig> {
  async deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<NativeWarpArtifactConfig, DeployedWarpAddress>,
  ): Promise<AnnotatedAltAddress[]> {
    const warpProgramId = parseAddress(deployed.deployed.address);
    const tokenPda = await deriveHyperlaneTokenPda(warpProgramId);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(warpProgramId);
    const nativeCollateralPda = await deriveNativeCollateralPda(warpProgramId);

    const out: AnnotatedAltAddress[] = [
      { address: warpProgramId, description: 'warp.program' },
      { address: tokenPda.address, description: 'warp.token_pda' },
      {
        address: dispatchAuthority.address,
        description: 'warp.dispatch_authority',
      },
      {
        address: nativeCollateralPda.address,
        description: 'warp.native_collateral_pda',
      },
    ];

    out.push(
      ...(await deriveWarpRouteCommonAltAddresses({
        chainName: this.chainName,
        rpc: this.rpc,
        config: deployed.config,
        warpProgram: warpProgramId,
        feeTokenMint: SYSTEM_PROGRAM_ADDRESS,
      })),
    );

    return canonicalize(out);
  }
}

/**
 * Adds the signer-requiring `create` path on top of
 * `SvmNativeTokenAltReader`. Constructed with a
 * `SvmAddressLookupTableWriter`, which is passed up to the base reader
 * (writer extends reader on the generic ALT side) and also stored
 * locally for the create path.
 *
 * v1 always emits exactly one entry in `warpSpecific`; the array shape
 * is forward-compatible with future capacity-driven splits.
 */
export class SvmNativeTokenAltWriter
  extends SvmNativeTokenAltReader
  implements SvmTokenAltWriter<NativeWarpArtifactConfig>
{
  constructor(
    chainName: string,
    rpc: SvmRpc,
    protected readonly altWriter: SvmAddressLookupTableWriter,
    private readonly existingCoreAlt?: Address,
  ) {
    super(chainName, rpc, altWriter);
  }

  /**
   * Creates the frozen ALTs that compose a native warp route's
   * lookup-table coverage on chain: the chain-shared core ALT (SDK
   * constants + mailbox + IGP) and one-or-more warp-route-specific
   * ALTs (warp PDAs + plugin static + fee + per-destination cascades).
   * All are frozen on creation, matching the registered-once /
   * regenerate-on-change trust model. When the ctor was given an
   * `existingCoreAlt`, that address is reused as the core slot.
   */
  async create(
    deployed: ArtifactDeployed<NativeWarpArtifactConfig, DeployedWarpAddress>,
  ): Promise<{
    core: Address;
    warpSpecific: Address[];
    receipts: SvmReceipt[];
  }> {
    const addresses = await this.computeExpectedAltAddresses(deployed);
    return createWarpAltsImpl(this.altWriter, addresses, this.existingCoreAlt);
  }
}
