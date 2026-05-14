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

import {
  type SvmAddressLookupTableWriter,
  type SvmAltConfig,
  type SvmDeployedAlt,
  nonEmptyArray,
} from './address-lookup-table.js';
import {
  type BucketDiff,
  type SvmTokenAltWriter,
  deriveCoreDeploymentAltAddresses,
  deriveFeeQuoteCascadeAltAddresses,
  deriveIgpQuoteCascadeAltAddresses,
  diffBucket,
} from './warp-alt.js';

/**
 * Builds the warp-route-specific ALT address set for a synthetic SVM
 * warp route: the warp program + its hyperlane_token PDA + the
 * mailbox-dispatch-authority PDA + the synthetic plugin's static
 * accounts `[token_2022_program, mint_pda]`; and, when the expanded
 * config carries a deployed fee artifact, the fee program + fee
 * account PDA + fee beneficiary ATA + the per-destination fee cascade
 * returned by `deriveFeeQuoteCascadeAltAddresses`. The IGP cascade
 * (when an IGP hook is present) uses the synthetic mint PDA as the
 * fee-token mint. Output is base58-sorted and set-deduped.
 *
 * Synthetic mints are always owned by the Token-2022 program; no
 * on-chain owner check is needed (matches `synthetic-token.ts`).
 */
export class SvmSyntheticTokenAltWriter implements SvmTokenAltWriter<SyntheticWarpArtifactConfig> {
  constructor(
    protected readonly chainName: string,
    protected readonly altWriter: SvmAddressLookupTableWriter,
  ) {}

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

  async read(addresses: { core: Address; warpSpecific: Address[] }): Promise<{
    core: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>;
    warpSpecific: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>[];
  }> {
    const core = await this.altWriter.read(addresses.core);
    const warpSpecific = await Promise.all(
      addresses.warpSpecific.map((addr) => this.altWriter.read(addr)),
    );
    return { core, warpSpecific };
  }

  async check(
    addresses: { core: Address; warpSpecific: Address[] },
    deployed: ArtifactDeployed<
      SyntheticWarpArtifactConfig,
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

  private async computeExpectedAltAddresses(
    deployed: ArtifactDeployed<
      SyntheticWarpArtifactConfig,
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
