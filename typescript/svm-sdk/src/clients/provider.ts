import {
  AccountRole,
  type TransactionMessageBytesBase64,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  address as parseAddress,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  composeWarpDeployGas,
  type WarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import {
  DEFAULT_COMPUTE_UNITS,
  LAMPORTS_PER_SIGNATURE,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { createRpc } from '../rpc.js';
import type { SvmRpc, SvmTransaction } from '../types.js';

// Warp-deploy cost breakdown for Sealevel. Composed additively in
// getMinGasForWarpDeploy() based on the WarpConfig shape.
//
// Numbers observed from live cross-collateral + fee-program deploys on
// mainnet-beta; the base value matches the flat WARP_DEPLOY_GAS used before
// this method existed (~2.6 SOL covers program account rent + token PDA rent
// + ATA payer funding for a base router).
export const WARP_DEPLOY_BASE_LAMPORTS = 2_600_000_000n; // base router deploy
export const WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS = 1_100_000_000n; // + crossCollateral router extras (~1.1 SOL)
export const WARP_DEPLOY_FEE_PROGRAM_LAMPORTS = 2_500_000_000n; // + fee program deploy (~2.5 SOL, separate program)
// TODO: fill from observed deploy — we don't have a measured breakdown for
// custom ISM / hook deploys on Sealevel yet, so these currently contribute
// nothing until real numbers land.
export const WARP_DEPLOY_CUSTOM_ISM_LAMPORTS = 0n; // + custom ISM (config.interchainSecurityModule object)
export const WARP_DEPLOY_CUSTOM_HOOK_LAMPORTS = 0n; // + custom hook / IGP (config.hook object)

export class SvmProvider implements AltVM.IProvider<SvmTransaction> {
  protected rpc: SvmRpc;
  protected rpcUrls: string[];
  protected chainMetadata: ChainMetadataForAltVM;

  static async connect(metadata: ChainMetadataForAltVM): Promise<SvmProvider> {
    const rpcUrls = (metadata.rpcUrls ?? []).map((rpc) => rpc.http);
    assert(rpcUrls.length > 0, 'At least one RPC URL is required');
    const rpc = createRpc(rpcUrls[0]);
    return new SvmProvider(rpc, rpcUrls, metadata);
  }

  constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
  ) {
    this.rpc = rpc;
    this.rpcUrls = rpcUrls;
    this.chainMetadata = chainMetadata;
  }

  async getMinGasForWarpDeploy(
    warpConfig: WarpArtifactConfig,
  ): Promise<bigint> {
    return composeWarpDeployGas(warpConfig, {
      base: WARP_DEPLOY_BASE_LAMPORTS,
      crossCollateralExtra: WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS,
      feeProgram: WARP_DEPLOY_FEE_PROGRAM_LAMPORTS,
      customIsm: WARP_DEPLOY_CUSTOM_ISM_LAMPORTS,
      customHook: WARP_DEPLOY_CUSTOM_HOOK_LAMPORTS,
    });
  }

  getRpc(): SvmRpc {
    return this.rpc;
  }

  // ### QUERY BASE ###

  async isHealthy(): Promise<boolean> {
    try {
      await this.rpc.getSlot().send();
      return true;
    } catch (error) {
      rootLogger.debug('SVM health check failed', { error });
      return false;
    }
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight(): Promise<number> {
    const slot = await this.rpc.getSlot().send();
    return Number(slot);
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    const balance = await this.rpc.getBalance(parseAddress(req.address)).send();
    return balance.value;
  }

  async getTotalSupply(_req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    throw new Error('getTotalSupply not supported on Sealevel');
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<SvmTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    const signerAddresses = new Set<string>();

    // Collect signers from instruction account metas
    for (const ix of req.transaction.instructions) {
      if (ix.accounts) {
        for (const account of ix.accounts) {
          if (account.role >= AccountRole.READONLY_SIGNER) {
            signerAddresses.add(account.address);
          }
        }
      }
    }

    // Collect additional signers
    for (const signer of req.transaction.additionalSigners ?? []) {
      signerAddresses.add(signer.address);
    }

    // +1 for fee payer (may already be in the set, but overcount to be safe)
    const numSigners = signerAddresses.size + 1;

    const gasPrice = await this.queryBaseFeePerSignature();
    const fee = BigInt(numSigners) * BigInt(gasPrice);
    const gasUnits = BigInt(
      req.transaction.computeUnits ?? DEFAULT_COMPUTE_UNITS,
    );
    return { gasUnits, gasPrice, fee };
  }

  /**
   * Queries the RPC for the base fee per signature using a minimal
   * unsigned message.
   */
  private async queryBaseFeePerSignature(): Promise<number> {
    try {
      const { value: latestBlockhash } = await this.rpc
        .getLatestBlockhash()
        .send();

      const baseMessage = createTransactionMessage({ version: 0 });
      const withFeePayer = setTransactionMessageFeePayer(
        SYSTEM_PROGRAM_ADDRESS,
        baseMessage,
      );
      const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        withFeePayer,
      );

      const compiled = compileTransactionMessage(withLifetime);
      const messageBytes =
        getCompiledTransactionMessageEncoder().encode(compiled);
      const base64Message = Buffer.from(messageBytes).toString(
        'base64',
      ) as TransactionMessageBytesBase64;

      const result = await this.rpc.getFeeForMessage(base64Message).send();
      if (result.value != null) {
        return Number(result.value);
      }
    } catch (error) {
      rootLogger.debug('getFeeForMessage failed, using static fallback', {
        error,
      });
    }
    return LAMPORTS_PER_SIGNATURE;
  }

  async isMessageDelivered(
    _req: AltVM.ReqIsMessageDelivered,
  ): Promise<boolean> {
    throw new Error(
      'isMessageDelivered not supported on Sealevel, use the Artifact API instead',
    );
  }

  // ### QUERY WARP ###

  async getToken(_req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    throw new Error(
      'getToken not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getRemoteRouters(
    _req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    throw new Error(
      'getRemoteRouters not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getBridgedSupply(_req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    throw new Error(
      'getBridgedSupply not supported on Sealevel, use the Artifact API instead',
    );
  }

  async quoteRemoteTransfer(
    _req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    throw new Error(
      'quoteRemoteTransfer not supported on Sealevel, use the Artifact API instead',
    );
  }
}
