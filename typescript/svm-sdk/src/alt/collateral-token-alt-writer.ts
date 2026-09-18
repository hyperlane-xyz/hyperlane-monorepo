import { type Address, address as parseAddress } from '@solana/kit';

import { type ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type CollateralWarpArtifactConfig,
  type DeployedWarpAddress,
} from '@hyperlane-xyz/provider-sdk/warp';

import { fetchMintTokenProgram } from '../accounts/mint.js';
import {
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
 * Read-only ALT surface for a collateral SVM warp route. Owns the
 * warp-route address derivation; shared `read` / `check` /
 * `computeExpectedAltAddresses` come from `SvmTokenAltReaderBase`.
 *
 * The token program (classic SPL vs Token-2022) is determined by
 * reading the mint's `owner` on-chain via `fetchMintTokenProgram`,
 * matching what the on-chain collateral plugin does at runtime.
 */
export class SvmCollateralTokenAltReader extends SvmTokenAltReaderBase<CollateralWarpArtifactConfig> {
  constructor(
    chainName: string,
    rpc: SvmRpc,
    altReader: SvmAddressLookupTableReader,
  ) {
    super(chainName, rpc, altReader);
  }

  async deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<
      CollateralWarpArtifactConfig,
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

export class SvmCollateralTokenAltWriter
  extends SvmCollateralTokenAltReader
  implements SvmTokenAltWriter<CollateralWarpArtifactConfig>
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
      CollateralWarpArtifactConfig,
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
