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

import {
  type SvmAddressLookupTableReader,
  type SvmAddressLookupTableWriter,
  type SvmAltConfig,
  type SvmDeployedAlt,
  nonEmptyArray,
} from './address-lookup-table.js';
import {
  type BucketDiff,
  type SvmTokenAltReader,
  type SvmTokenAltWriter,
  deriveCoreDeploymentAltAddresses,
  deriveFeeQuoteCascadeAltAddresses,
  deriveIgpQuoteCascadeAltAddresses,
  diffBucket,
} from './warp-alt.js';

/**
 * Read-only ALT surface for a native SVM warp route. Owns the address
 * derivation (`deriveWarpRouteAddresses`), on-chain ALT reads, and the
 * `check` diff that compares actual vs expected. Constructed with just
 * a `SvmAddressLookupTableReader` — no signer needed.
 *
 * The companion `SvmNativeTokenAltWriter` extends this and adds
 * `create`.
 */
export class SvmNativeTokenAltReader implements SvmTokenAltReader<NativeWarpArtifactConfig> {
  constructor(
    protected readonly chainName: string,
    protected readonly altReader: SvmAddressLookupTableReader,
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

  /**
   * Reads both buckets of ALTs from chain for this native warp route.
   * Pure pass-through to the generic `SvmAddressLookupTableReader`.
   */
  async read(addresses: { core: string; warpSpecific: string[] }): Promise<{
    core: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>;
    warpSpecific: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>[];
  }> {
    const core = await this.altReader.read(addresses.core);
    const warpSpecific = await Promise.all(
      addresses.warpSpecific.map((addr) => this.altReader.read(addr)),
    );
    return { core, warpSpecific };
  }

  /**
   * Diffs the on-chain ALT contents against what would be regenerated
   * for the given expanded warp config. Output groups differences by
   * bucket; the `warpSpecific` bucket aggregates the address sets across
   * all warp-specific ALTs (v1 has just one).
   *
   * Since `create` always freezes, an unfrozen actual ALT is treated as
   * a divergence — `frozenMismatch: true` flags it.
   */
  async check(
    addresses: { core: string; warpSpecific: string[] },
    deployed: ArtifactDeployed<NativeWarpArtifactConfig, DeployedWarpAddress>,
  ): Promise<{
    core: BucketDiff;
    warpSpecific: BucketDiff;
  }> {
    const actual = await this.read(addresses);
    const expected = await this.computeExpectedAltAddresses(deployed);

    return {
      core: diffBucket(
        actual.core.config.addresses,
        expected.core,
        actual.core.config.frozen,
      ),
      warpSpecific: diffBucket(
        actual.warpSpecific.flatMap((a) => a.config.addresses),
        expected.warpSpecific,
        actual.warpSpecific.every((a) => a.config.frozen),
      ),
    };
  }

  /**
   * Computes the expected core + warp-specific address lists for the
   * given expanded warp config. Shared by the writer's `create` (to
   * emit the ALTs) and this reader's `check` (to diff against what's
   * on chain), keeping the two code paths in lockstep.
   */
  protected async computeExpectedAltAddresses(
    deployed: ArtifactDeployed<NativeWarpArtifactConfig, DeployedWarpAddress>,
  ): Promise<{ core: Address[]; warpSpecific: Address[] }> {
    const mailbox = parseAddress(deployed.config.mailbox);
    const hook = deployed.config.hook;
    assert(
      isNullish(hook) || isArtifactDeployed(hook),
      'Expected hook artifact to be expanded (DEPLOYED) or not set',
    );
    const igpContext =
      hook?.config.type === HookType.INTERCHAIN_GAS_PAYMASTER
        ? {
            programId: parseAddress(hook.deployed.address),
            igpSalt: DEFAULT_IGP_SALT,
            includeOverheadIgp: Object.keys(hook.config.overhead).length > 0,
          }
        : undefined;

    return {
      core: await deriveCoreDeploymentAltAddresses(mailbox, igpContext),
      warpSpecific: await this.deriveWarpRouteAddresses(deployed),
    };
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
    const { core, warpSpecific } =
      await this.computeExpectedAltAddresses(deployed);

    const [coreAlt, coreReceipts] = await this.altWriter.create({
      config: { frozen: true, addresses: nonEmptyArray(core) },
    });
    const [warpAlt, warpReceipts] = await this.altWriter.create({
      config: { frozen: true, addresses: nonEmptyArray(warpSpecific) },
    });

    return {
      core: coreAlt.deployed.address,
      warpSpecific: [warpAlt.deployed.address],
      receipts: [...coreReceipts, ...warpReceipts],
    };
  }
}
