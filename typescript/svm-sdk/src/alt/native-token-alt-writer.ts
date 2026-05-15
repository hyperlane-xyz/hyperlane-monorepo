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

import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { resolveFeeSalt } from '../fee/types.js';
import { DEFAULT_IGP_SALT } from '../hook/igp-hook.js';
import {
  deriveHyperlaneTokenPda,
  deriveIgpAccountPda,
  deriveMailboxDispatchAuthorityPda,
  deriveNativeCollateralPda,
} from '../pda.js';
import type { SvmReceipt } from '../types.js';

import { type SvmAddressLookupTableWriter } from './address-lookup-table.js';
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
 * Read-only ALT surface for a native SVM warp route. Owns the
 * `deriveWarpRouteAddresses` derivation; shared `read` / `check` /
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
      out.push(
        {
          address: parseAddress(fee.config.beneficiary),
          description: 'fee.beneficiary',
        },
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
        feeTokenMint: SYSTEM_PROGRAM_ADDRESS,
        sender: warpProgramId,
        enrolledDomains,
      });
      out.push(...igpCascade);
    }

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
    protected readonly altWriter: SvmAddressLookupTableWriter,
  ) {
    super(chainName, altWriter);
  }

  /**
   * Creates the two frozen ALTs that compose a native warp route's
   * lookup-table coverage on chain: the chain-shared core ALT (SDK
   * constants + mailbox + IGP) and the warp-route-specific ALT (warp
   * PDAs + plugin static + fee + per-destination cascades). Both are
   * frozen on creation, matching the registered-once /
   * regenerate-on-change trust model.
   */
  async create(
    deployed: ArtifactDeployed<NativeWarpArtifactConfig, DeployedWarpAddress>,
  ): Promise<{
    core: Address;
    warpSpecific: Address[];
    receipts: SvmReceipt[];
  }> {
    const addresses = await this.computeExpectedAltAddresses(deployed);
    return createWarpAltsImpl(this.altWriter, addresses);
  }
}
