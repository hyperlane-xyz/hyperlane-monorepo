import { type Address, address as parseAddress } from '@solana/kit';

import { type ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type SyntheticWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { TOKEN_2022_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveSyntheticMintPda,
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
 * Read-only ALT surface for a synthetic SVM warp route. Owns the
 * warp-route address derivation; shared `read` / `check` /
 * `computeExpectedAltAddresses` come from `SvmTokenAltReaderBase`.
 *
 * Synthetic mints are always owned by the Token-2022 program; no
 * on-chain owner check is needed (matches `synthetic-token.ts`).
 */
export class SvmSyntheticTokenAltReader extends SvmTokenAltReaderBase<SyntheticWarpArtifactConfig> {
  async deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<
      SyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedAltAddress[]> {
    const warpProgramId = parseAddress(deployed.deployed.address);
    const mintPda = await deriveSyntheticMintPda(warpProgramId);
    const mint = mintPda.address;

    const tokenPda = await deriveHyperlaneTokenPda(warpProgramId);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(warpProgramId);

    const out: AnnotatedAltAddress[] = [
      { address: warpProgramId, description: 'warp.program' },
      { address: tokenPda.address, description: 'warp.token_pda' },
      {
        address: dispatchAuthority.address,
        description: 'warp.dispatch_authority',
      },
      {
        address: TOKEN_2022_PROGRAM_ADDRESS,
        description: 'warp.token_program',
      },
      { address: mint, description: 'warp.synthetic_mint_pda' },
    ];

    out.push(
      ...(await deriveWarpRouteCommonAltAddresses({
        chainName: this.chainName,
        rpc: this.rpc,
        config: deployed.config,
        warpProgram: warpProgramId,
        feeTokenMint: mint,
        feeBeneficiaryToken: {
          mint,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        },
      })),
    );

    return canonicalize(out);
  }
}

export class SvmSyntheticTokenAltWriter
  extends SvmSyntheticTokenAltReader
  implements SvmTokenAltWriter<SyntheticWarpArtifactConfig>
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
      SyntheticWarpArtifactConfig,
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
