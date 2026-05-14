import { type Address, address as parseAddress } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  isArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type SyntheticWarpArtifactConfig,
  buildFeeReadContextFromWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import { TOKEN_2022_PROGRAM_ADDRESS } from '../constants.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import {
  deriveAssociatedTokenAddress,
  deriveHyperlaneTokenPda,
  deriveIgpAccountPda,
  deriveMailboxDispatchAuthorityPda,
  deriveSyntheticMintPda,
} from '../pda.js';
import type { SvmReceipt } from '../types.js';

import { type SvmAddressLookupTableWriter } from './address-lookup-table.js';
import {
  type SvmTokenAltWriter,
  SvmTokenAltReaderBase,
  createWarpAltsImpl,
  deriveFeeQuoteCascadeAltAddresses,
  deriveIgpQuoteCascadeAltAddresses,
} from './warp-alt.js';

/**
 * Read-only ALT surface for a synthetic SVM warp route. Owns the
 * `deriveWarpRouteAddresses` derivation; shared `read` / `check` /
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
  ): Promise<Address[]> {
    const warpProgramId = parseAddress(deployed.deployed.address);
    const mintPda = await deriveSyntheticMintPda(warpProgramId);
    const mint = mintPda.address;

    const tokenPda = await deriveHyperlaneTokenPda(warpProgramId);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(warpProgramId);

    const out: Address[] = [
      warpProgramId,
      tokenPda.address,
      dispatchAuthority.address,
      TOKEN_2022_PROGRAM_ADDRESS,
      mint,
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

      // SPL fees pay to an ATA derived from (beneficiary owner, mint,
      // token program) — never the wallet directly.
      const beneficiaryAta = await deriveAssociatedTokenAddress({
        wallet: parseAddress(fee.config.beneficiary),
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
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

export class SvmSyntheticTokenAltWriter
  extends SvmSyntheticTokenAltReader
  implements SvmTokenAltWriter<SyntheticWarpArtifactConfig>
{
  constructor(
    chainName: string,
    protected readonly altWriter: SvmAddressLookupTableWriter,
  ) {
    super(chainName, altWriter);
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
    return createWarpAltsImpl(this.altWriter, addresses);
  }
}
