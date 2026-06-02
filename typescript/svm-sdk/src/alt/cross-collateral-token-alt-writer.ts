import { type Address, address as parseAddress } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  isArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type CrossCollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  buildFeeReadContextFromWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import { fetchMintTokenProgram } from '../accounts/mint.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import {
  deriveAssociatedTokenAddress,
  deriveCrossCollateralStatePda,
  deriveEscrowPda,
  deriveHyperlaneTokenPda,
  deriveIgpAccountPda,
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
  deriveFeeQuoteCascadeAltAddresses,
  deriveIgpQuoteCascadeAltAddresses,
} from './warp-alt.js';

/**
 * Read-only ALT surface for a cross-collateral SVM warp route. Owns
 * the `deriveWarpRouteAddresses` derivation; shared `read` / `check` /
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
    protected readonly rpc: SvmRpc,
    altReader: SvmAddressLookupTableReader,
  ) {
    super(chainName, altReader);
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

    const fee = deployed.config.fee;
    assert(
      isNullish(fee) || isArtifactDeployed(fee),
      'Expected fee artifact to be expanded (DEPLOYED) or not set',
    );

    if (fee) {
      const cascade = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: parseAddress(fee.deployed.address),
        feeSalt: resolveFeeSalt(this.chainName),
        feeConfig: fee.config,
        feeReadContext: buildFeeReadContextFromWarpArtifactConfig(
          deployed.config,
        ),
      });

      const beneficiaryAta = await deriveAssociatedTokenAddress({
        wallet: parseAddress(fee.config.beneficiary),
        mint,
        tokenProgram,
      });
      out.push(
        { address: beneficiaryAta.address, description: 'fee.beneficiary_ata' },
        ...cascade,
      );
    }

    const hook = deployed.config.hook;
    assert(
      isNullish(hook) || isArtifactDeployed(hook),
      'Expected hook artifact to be expanded (DEPLOYED) or not set',
    );

    if (hook?.config.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
      const igpProgramId = parseAddress(hook.deployed.address);
      const igpAccount = await deriveIgpAccountPda(
        igpProgramId,
        DEFAULT_IGP_SALT,
      );
      const enrolledDomains = Object.keys(deployed.config.remoteRouters).map(
        Number,
      );

      const igpCascade = await deriveIgpQuoteCascadeAltAddresses({
        igpProgram: igpProgramId,
        igpAccount: igpAccount.address,
        feeTokenMint: mint,
        sender: warpProgramId,
        enrolledDomains,
      });
      out.push(...igpCascade);
    }

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
