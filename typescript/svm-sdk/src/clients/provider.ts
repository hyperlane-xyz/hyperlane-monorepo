import {
  type TransactionMessageBytesBase64,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  address as parseAddress,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import {
  LAMPORTS_PER_SIGNATURE,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { createRpc } from '../rpc.js';
import { DEFAULT_COMPUTE_UNITS } from '../tx.js';
import type { SvmRpc, SvmTransaction } from '../types.js';

export class SvmProvider implements AltVM.IProvider<SvmTransaction> {
  protected rpc: SvmRpc;
  protected rpcUrls: string[];

  static async connect(
    rpcUrls: string[],
    _chainId: string | number,
    _extraParams?: Record<string, any>,
  ): Promise<SvmProvider> {
    assert(rpcUrls.length > 0, 'At least one RPC URL is required');
    const rpc = createRpc(rpcUrls[0]);
    return new SvmProvider(rpc, rpcUrls);
  }

  constructor(rpc: SvmRpc, rpcUrls: string[]) {
    this.rpc = rpc;
    this.rpcUrls = rpcUrls;
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
    const numSigners = 1 + (req.transaction.additionalSigners?.length ?? 0);
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

  // ### QUERY CORE ###

  async getMailbox(_req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    throw new Error('getMailbox not supported on Sealevel');
  }

  async isMessageDelivered(
    _req: AltVM.ReqIsMessageDelivered,
  ): Promise<boolean> {
    throw new Error('isMessageDelivered not supported on Sealevel');
  }

  async getIsmType(_req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    throw new Error('getIsmType not supported on Sealevel');
  }

  async getMessageIdMultisigIsm(
    _req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    throw new Error('getMessageIdMultisigIsm not supported on Sealevel');
  }

  async getMerkleRootMultisigIsm(
    _req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    throw new Error('getMerkleRootMultisigIsm not supported on Sealevel');
  }

  async getRoutingIsm(_req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    throw new Error('getRoutingIsm not supported on Sealevel');
  }

  async getNoopIsm(_req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    throw new Error('getNoopIsm not supported on Sealevel');
  }

  // ### QUERY HOOK ###

  async getHookType(_req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    throw new Error('getHookType not supported on Sealevel');
  }

  async getInterchainGasPaymasterHook(
    _req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    throw new Error('getInterchainGasPaymasterHook not supported on Sealevel');
  }

  async getMerkleTreeHook(
    _req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    throw new Error('getMerkleTreeHook not supported on Sealevel');
  }

  async getNoopHook(_req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook> {
    throw new Error('getNoopHook not supported on Sealevel');
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

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    _req: AltVM.ReqCreateMailbox,
  ): Promise<SvmTransaction> {
    throw new Error('getCreateMailboxTransaction not supported on Sealevel');
  }

  async getSetDefaultIsmTransaction(
    _req: AltVM.ReqSetDefaultIsm,
  ): Promise<SvmTransaction> {
    throw new Error('getSetDefaultIsmTransaction not supported on Sealevel');
  }

  async getSetDefaultHookTransaction(
    _req: AltVM.ReqSetDefaultHook,
  ): Promise<SvmTransaction> {
    throw new Error('getSetDefaultHookTransaction not supported on Sealevel');
  }

  async getSetRequiredHookTransaction(
    _req: AltVM.ReqSetRequiredHook,
  ): Promise<SvmTransaction> {
    throw new Error('getSetRequiredHookTransaction not supported on Sealevel');
  }

  async getSetMailboxOwnerTransaction(
    _req: AltVM.ReqSetMailboxOwner,
  ): Promise<SvmTransaction> {
    throw new Error('getSetMailboxOwnerTransaction not supported on Sealevel');
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    _req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateMerkleRootMultisigIsmTransaction not supported on Sealevel',
    );
  }

  async getCreateMessageIdMultisigIsmTransaction(
    _req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateMessageIdMultisigIsmTransaction not supported on Sealevel',
    );
  }

  async getCreateRoutingIsmTransaction(
    _req: AltVM.ReqCreateRoutingIsm,
  ): Promise<SvmTransaction> {
    throw new Error('getCreateRoutingIsmTransaction not supported on Sealevel');
  }

  async getSetRoutingIsmRouteTransaction(
    _req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetRoutingIsmRouteTransaction not supported on Sealevel',
    );
  }

  async getRemoveRoutingIsmRouteTransaction(
    _req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getRemoveRoutingIsmRouteTransaction not supported on Sealevel',
    );
  }

  async getSetRoutingIsmOwnerTransaction(
    _req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetRoutingIsmOwnerTransaction not supported on Sealevel',
    );
  }

  async getCreateNoopIsmTransaction(
    _req: AltVM.ReqCreateNoopIsm,
  ): Promise<SvmTransaction> {
    throw new Error('getCreateNoopIsmTransaction not supported on Sealevel');
  }

  async getCreateMerkleTreeHookTransaction(
    _req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateMerkleTreeHookTransaction not supported on Sealevel',
    );
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    _req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateInterchainGasPaymasterHookTransaction not supported on Sealevel',
    );
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    _req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetInterchainGasPaymasterHookOwnerTransaction not supported on Sealevel',
    );
  }

  async getSetDestinationGasConfigTransaction(
    _req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetDestinationGasConfigTransaction not supported on Sealevel',
    );
  }

  async getRemoveDestinationGasConfigTransaction(
    _req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getRemoveDestinationGasConfigTransaction not supported on Sealevel',
    );
  }

  async getCreateNoopHookTransaction(
    _req: AltVM.ReqCreateNoopHook,
  ): Promise<SvmTransaction> {
    throw new Error('getCreateNoopHookTransaction not supported on Sealevel');
  }

  async getCreateValidatorAnnounceTransaction(
    _req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateValidatorAnnounceTransaction not supported on Sealevel',
    );
  }

  async getCreateProxyAdminTransaction(
    _req: AltVM.ReqCreateProxyAdmin,
  ): Promise<SvmTransaction> {
    throw new Error('getCreateProxyAdminTransaction not supported on Sealevel');
  }

  async getSetProxyAdminOwnerTransaction(
    _req: AltVM.ReqSetProxyAdminOwner,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetProxyAdminOwnerTransaction not supported on Sealevel',
    );
  }

  // ### GET WARP TXS ###

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateNativeTokenTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getCreateCollateralTokenTransaction(
    _req: AltVM.ReqCreateCollateralToken,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateCollateralTokenTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getCreateSyntheticTokenTransaction(
    _req: AltVM.ReqCreateSyntheticToken,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getCreateSyntheticTokenTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getSetTokenOwnerTransaction(
    _req: AltVM.ReqSetTokenOwner,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetTokenOwnerTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getSetTokenIsmTransaction(
    _req: AltVM.ReqSetTokenIsm,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetTokenIsmTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getSetTokenHookTransaction(
    _req: AltVM.ReqSetTokenHook,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getSetTokenHookTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getEnrollRemoteRouterTransaction(
    _req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getEnrollRemoteRouterTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getUnenrollRemoteRouterTransaction(
    _req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getUnenrollRemoteRouterTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getTransferTransaction(
    _req: AltVM.ReqTransfer,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getTransferTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }

  async getRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
  ): Promise<SvmTransaction> {
    throw new Error(
      'getRemoteTransferTransaction not supported on Sealevel, use the Artifact API instead',
    );
  }
}
