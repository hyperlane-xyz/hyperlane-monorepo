import { type Address, address as parseAddress } from '@solana/kit';

import { type ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type CrossCollateralWarpArtifactConfig,
  type DeployedWarpAddress,
} from '@hyperlane-xyz/provider-sdk/warp';

import { fetchMintTokenProgram } from '../accounts/mint.js';
import {
  deriveCrossCollateralStatePda,
  deriveEscrowPda,
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
} from '../pda.js';
import type { SvmReceipt, SvmRpc } from '../types.js';

import {
  type SvmAddressLookupTableReader,
  type SvmAddressLookupTableWriter,
} from './address-lookup-table.js';
import {
  type AnnotatedAltAddress,
  type SvmTokenAltWriter,
  SvmTokenAltReaderBase,
  canonicalize,
  createWarpAltsImpl,
  deriveWarpRouteCommonAltAddresses,
} from './warp-alt.js';

/**
 * Read-only ALT surface for a cross-collateral SVM warp route. Owns
 * the warp-route address derivation; shared `read` / `check` /
 * `computeExpectedAltAddresses` come from `SvmTokenAltReaderBase`.
 *
 * Same shape as the collateral reader plus the cross-collateral state
 * PDA in the plugin static, and the fee cascade variant kicks into its
 * CrossCollateralRouting branch via
 * `buildFeeReadContextFromWarpArtifactConfig`, which surfaces every
 * `(domain, target_router)` pair from the warp's
 * `crossCollateralRouters` config.
 *
 * Uses the standard mailbox dispatch authority (the local
 * `cross_collateral_dispatch_authority` PDA is only consumed on the
 * `transferRemoteToLocal` HandleLocal CPI path, which is out of scope
 * for transferRemote / transferRemoteTo-to-remote ALTs).
 */
export class SvmCrossCollateralTokenAltReader extends SvmTokenAltReaderBase<CrossCollateralWarpArtifactConfig> {
  constructor(
    chainName: string,
    rpc: SvmRpc,
    altReader: SvmAddressLookupTableReader,
  ) {
    super(chainName, rpc, altReader);
  }

  async deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<
      CrossCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedAltAddress[]> {
    const warpProgramId = parseAddress(deployed.deployed.address);
    const mint = parseAddress(deployed.config.token);
    const tokenProgram = await fetchMintTokenProgram(this.rpc, mint);

    const tokenPda = await deriveHyperlaneTokenPda(warpProgramId);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(warpProgramId);
    const escrowPda = await deriveEscrowPda(warpProgramId);
    const ccStatePda = await deriveCrossCollateralStatePda(warpProgramId);

    const out: AnnotatedAltAddress[] = [
      { address: warpProgramId, description: 'warp.program' },
      { address: tokenPda.address, description: 'warp.token_pda' },
      {
        address: dispatchAuthority.address,
        description: 'warp.dispatch_authority',
      },
      { address: tokenProgram, description: 'warp.token_program' },
      { address: mint, description: 'warp.collateral_mint' },
      { address: escrowPda.address, description: 'warp.escrow_pda' },
      {
        address: ccStatePda.address,
        description: 'warp.cross_collateral_state',
      },
    ];

    out.push(
      ...(await deriveWarpRouteCommonAltAddresses({
        chainName: this.chainName,
        rpc: this.rpc,
        config: deployed.config,
        warpProgram: warpProgramId,
        feeTokenMint: mint,
        feeBeneficiaryToken: { mint, tokenProgram },
      })),
    );

    return canonicalize(out);
  }
}

export class SvmCrossCollateralTokenAltWriter
  extends SvmCrossCollateralTokenAltReader
  implements SvmTokenAltWriter<CrossCollateralWarpArtifactConfig>
{
  constructor(
    chainName: string,
    rpc: SvmRpc,
    protected readonly altWriter: SvmAddressLookupTableWriter,
    private readonly existingCoreAlt?: Address,
  ) {
    super(chainName, rpc, altWriter);
  }

  async create(
    deployed: ArtifactDeployed<
      CrossCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<{
    core: Address;
    warpSpecific: Address[];
    receipts: SvmReceipt[];
  }> {
    const addresses = await this.computeExpectedAltAddresses(deployed);
    return createWarpAltsImpl(this.altWriter, addresses, this.existingCoreAlt);
  }
}
