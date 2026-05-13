import { type Address, address as parseAddress } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
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
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import {
  deriveHyperlaneTokenPda,
  deriveIgpAccountPda,
  deriveMailboxDispatchAuthorityPda,
  deriveNativeCollateralPda,
} from '../pda.js';

import {
  deriveFeeQuoteCascadeAltAddresses,
  deriveIgpQuoteCascadeAltAddresses,
} from './warp-alt.js';

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
      const cascade = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: parseAddress(fee.deployed.address),
        feeSalt: resolveFeeSalt(this.chainName),
        feeConfig: fee.config,
        feeReadContext: buildFeeReadContextFromWarpArtifactConfig(
          deployed.config,
        ),
      });
      out.push(parseAddress(fee.config.beneficiary), ...cascade);
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
        feeTokenMint: SYSTEM_PROGRAM_ADDRESS,
        sender: warpProgramId,
        enrolledDomains,
      });
      out.push(...igpCascade);
    }

    return [...new Set(out.map(parseAddress))].sort();
  }
}
