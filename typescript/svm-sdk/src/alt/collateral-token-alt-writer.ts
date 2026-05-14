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
 * Read-only ALT surface for a collateral SVM warp route. Builds the
 * warp-route-specific ALT address set: warp program + hyperlane_token
 * PDA + mailbox-dispatch-authority PDA + the collateral plugin's
 * static accounts `[spl_token_program, mint, escrow_pda]`; and, when
 * the expanded config carries a deployed fee artifact, the fee
 * program + fee account PDA + fee beneficiary ATA + the
 * per-destination fee cascade. The IGP cascade (when an IGP hook is
 * present) is computed with the collateral mint as the fee-token
 * mint. Output is base58-sorted and set-deduped.
 *
 * The token program (classic SPL vs Token-2022) is determined by
 * reading the mint's `owner` on-chain via `fetchMintTokenProgram`,
 * matching what the on-chain collateral plugin does at runtime.
 */
export class SvmCollateralTokenAltReader implements SvmTokenAltReader<CollateralWarpArtifactConfig> {
  constructor(
    protected readonly chainName: string,
    protected readonly rpc: SvmRpc,
    protected readonly altReader: SvmAddressLookupTableReader,
  ) {}

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

  async check(
    addresses: { core: string; warpSpecific: string[] },
    deployed: ArtifactDeployed<
      CollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
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

  protected async computeExpectedAltAddresses(
    deployed: ArtifactDeployed<
      CollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
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
