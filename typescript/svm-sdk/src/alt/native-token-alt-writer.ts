import { type Address, address as parseAddress } from '@solana/kit';

import {
  type ArtifactDeployed,
  isArtifactDeployed,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type NativeWarpArtifactConfig,
  buildFeeReadContextFromWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, isNullish } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { resolveFeeSalt } from '../fee/types.js';
import {
  deriveFeeAccountPda,
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveNativeCollateralPda,
} from '../pda.js';

import { deriveFeeQuoteCascadeAltAddresses } from './warp-alt.js';

/**
 * Builds the warp-route-specific ALT address set for a native SVM
 * warp route: the warp program + its hyperlane_token PDA + the
 * mailbox-dispatch-authority PDA + the native-collateral plugin PDA;
 * and, when the expanded config carries a deployed fee artifact, the
 * fee program + fee account PDA + fee beneficiary (the wallet directly
 * for native warps — no ATA derivation) + the per-destination fee
 * cascade returned by `deriveFeeQuoteCascadeAltAddresses`. Output is
 * base58-sorted and set-deduped.
 *
 * Per-destination IGP cascade PDAs are added by the follow-up commit;
 * create/read/check wrappers land alongside.
 */
export class SvmNativeTokenAltWriter {
  constructor(
    protected readonly signer: SvmSigner,
    protected readonly chainName: string,
  ) {}

  async deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<NativeWarpArtifactConfig, DeployedWarpAddress>,
  ): Promise<Address[]> {
    const warpProgramId = parseAddress(deployed.deployed.address);
    const tokenPda = await deriveHyperlaneTokenPda(warpProgramId);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(warpProgramId);
    const nativeCollateralPda = await deriveNativeCollateralPda(warpProgramId);

    const out: Address[] = [
      warpProgramId,
      tokenPda.address,
      dispatchAuthority.address,
      nativeCollateralPda.address,
    ];

    const fee = deployed.config.fee;
    assert(
      isNullish(fee) || isArtifactDeployed(fee),
      'Expected fee artifact to be expanded (DEPLOYED) or not set',
    );

    if (fee) {
      const feeProgram = parseAddress(fee.deployed.address);
      const feeAccount = await deriveFeeAccountPda(
        feeProgram,
        resolveFeeSalt(this.chainName),
      );
      out.push(feeProgram, feeAccount.address);
      out.push(parseAddress(fee.config.beneficiary));

      const cascade = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram,
        feeAccount: feeAccount.address,
        feeConfig: fee.config,
        feeReadContext: buildFeeReadContextFromWarpArtifactConfig(
          deployed.config,
        ),
      });
      out.push(...cascade);
    }

    return [...new Set(out.map(parseAddress))].sort();
  }
}
