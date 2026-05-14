import { type Address, address as parseAddress } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  isArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type CollateralWarpArtifactConfig,
  type DeployedWarpAddress,
  buildFeeReadContextFromWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import { fetchMintTokenProgram } from '../accounts/mint.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import {
  deriveAssociatedTokenAddress,
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
  type SvmTokenAltWriter,
  SvmTokenAltReaderBase,
  createWarpAltsImpl,
  deriveFeeQuoteCascadeAltAddresses,
  deriveIgpQuoteCascadeAltAddresses,
} from './warp-alt.js';

/**
 * Read-only ALT surface for a collateral SVM warp route. Owns the
 * `deriveWarpRouteAddresses` derivation; shared `read` / `check` /
 * `computeExpectedAltAddresses` come from `SvmTokenAltReaderBase`.
 *
 * The token program (classic SPL vs Token-2022) is determined by
 * reading the mint's `owner` on-chain via `fetchMintTokenProgram`,
 * matching what the on-chain collateral plugin does at runtime.
 */
export class SvmCollateralTokenAltReader extends SvmTokenAltReaderBase<CollateralWarpArtifactConfig> {
  constructor(
    chainName: string,
    protected readonly rpc: SvmRpc,
    altReader: SvmAddressLookupTableReader,
  ) {
    super(chainName, altReader);
  }

  async deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<
      CollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<Address[]> {
    const warpProgramId = parseAddress(deployed.deployed.address);
    const mint = parseAddress(deployed.config.token);
    const tokenProgram = await fetchMintTokenProgram(this.rpc, mint);

    const tokenPda = await deriveHyperlaneTokenPda(warpProgramId);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(warpProgramId);
    const escrowPda = await deriveEscrowPda(warpProgramId);

    const out: Address[] = [
      warpProgramId,
      tokenPda.address,
      dispatchAuthority.address,
      tokenProgram,
      mint,
      escrowPda.address,
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

      // SPL fees pay to an ATA derived from the beneficiary owner +
      // the warp's mint + the resolved token program — never the
      // wallet directly (that's the native warp's shape).
      const beneficiaryAta = await deriveAssociatedTokenAddress({
        wallet: parseAddress(fee.config.beneficiary),
        mint,
        tokenProgram,
      });
      out.push(beneficiaryAta.address, ...cascade);
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

    return [...new Set(out.map(parseAddress))].sort();
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
    return createWarpAltsImpl(this.altWriter, addresses);
  }
}
