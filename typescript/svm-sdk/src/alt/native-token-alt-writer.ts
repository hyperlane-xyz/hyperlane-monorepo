import { type Address, address as parseAddress } from '@solana/kit';

import {
  type ArtifactDeployed,
  isArtifactNew,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedWarpAddress,
  NativeWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { resolveFeeSalt } from '../fee/types.js';
import {
  deriveFeeAccountPda,
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
  deriveNativeCollateralPda,
} from '../pda.js';
import type { SvmRpc } from '../types.js';
import { assert, isNullish } from '@hyperlane-xyz/utils';

/**
 * Builds the warp-route-specific ALT address set for a native SVM
 * warp route: the warp program, its `hyperlane_token` PDA, the
 * mailbox-dispatch-authority PDA, the native-collateral plugin PDA,
 * and — when the expanded config carries a fee artifact — the fee
 * program + fee account PDA (derived from the program plus the
 * chain's resolved fee salt). Output is base58-sorted and
 * set-deduped.
 *
 * Per-destination fee/IGP cascade PDAs and the on-chain
 * fee-account-derived `fee_beneficiary` are added in a follow-up
 * commit that wires the create/read/check wrappers and e2e
 * coverage; those require RPC simulation / fetches.
 */
export class SvmNativeTokenAltWriter {
  constructor(
    protected readonly rpc: SvmRpc,
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
      isNullish(fee) || !isArtifactNew(fee),
      'Expected fee to be deployed or not set',
    );

    if (fee) {
      const feeProgram = parseAddress(fee.deployed.address);
      const feeAccount = await deriveFeeAccountPda(
        feeProgram,
        resolveFeeSalt(this.chainName),
      );
      out.push(feeProgram, feeAccount.address);
    }

    return [...new Set(out.map(parseAddress))].sort();
  }
}
