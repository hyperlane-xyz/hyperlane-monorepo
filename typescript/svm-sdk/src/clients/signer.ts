import type { Address } from '@solana/kit';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import { createRpc } from '../rpc.js';
import { type SvmSigner, createSigner } from '../signer.js';
import type { SvmReceipt, SvmRpc, SvmTransaction } from '../types.js';

import { SealevelProvider } from './provider.js';

export class SealevelSigner
  extends SealevelProvider
  implements AltVM.ISigner<SvmTransaction, SvmReceipt>
{
  private readonly svmSigner: SvmSigner;
  private readonly signerAddress: Address;

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    svmSigner: SvmSigner,
    signerAddress: Address,
  ) {
    super(rpc, rpcUrls);
    this.svmSigner = svmSigner;
    this.signerAddress = signerAddress;
  }

  static async connectWithSigner(
    rpcUrls: string[],
    privateKey: string,
    _extraParams?: Record<string, any>,
  ): Promise<SealevelSigner> {
    assert(rpcUrls.length > 0, 'At least one RPC URL is required');
    const rpc = createRpc(rpcUrls[0]);
    const signer = await createSigner(privateKey, rpc);
    return new SealevelSigner(rpc, rpcUrls, signer, signer.address);
  }

  getSignerAddress(): string {
    return this.signerAddress;
  }

  supportsTransactionBatching(): boolean {
    return false;
  }

  async transactionToPrintableJson(
    transaction: SvmTransaction,
  ): Promise<object> {
    return {
      instructions: transaction.instructions.map((ix) => ({
        programAddress: ix.programAddress,
        accounts: ix.accounts,
        data: ix.data ? Buffer.from(ix.data).toString('hex') : undefined,
      })),
      computeUnits: transaction.computeUnits,
    };
  }

  async sendAndConfirmTransaction(
    transaction: SvmTransaction,
  ): Promise<SvmReceipt> {
    return this.svmSigner.send(transaction);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: SvmTransaction[],
  ): Promise<SvmReceipt> {
    throw new Error('Sealevel does not support transaction batching');
  }

  // ### TX CORE ###

  async createMailbox(
    _req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox> {
    throw new Error('createMailbox not supported on Sealevel');
  }

  async setDefaultIsm(
    _req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm> {
    throw new Error('setDefaultIsm not supported on Sealevel');
  }

  async setDefaultHook(
    _req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook> {
    throw new Error('setDefaultHook not supported on Sealevel');
  }

  async setRequiredHook(
    _req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook> {
    throw new Error('setRequiredHook not supported on Sealevel');
  }

  async setMailboxOwner(
    _req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner> {
    throw new Error('setMailboxOwner not supported on Sealevel');
  }

  async createMerkleRootMultisigIsm(
    _req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm> {
    throw new Error('createMerkleRootMultisigIsm not supported on Sealevel');
  }

  async createMessageIdMultisigIsm(
    _req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm> {
    throw new Error('createMessageIdMultisigIsm not supported on Sealevel');
  }

  async createRoutingIsm(
    _req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm> {
    throw new Error('createRoutingIsm not supported on Sealevel');
  }

  async setRoutingIsmRoute(
    _req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute> {
    throw new Error('setRoutingIsmRoute not supported on Sealevel');
  }

  async removeRoutingIsmRoute(
    _req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute> {
    throw new Error('removeRoutingIsmRoute not supported on Sealevel');
  }

  async setRoutingIsmOwner(
    _req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner> {
    throw new Error('setRoutingIsmOwner not supported on Sealevel');
  }

  async createNoopIsm(
    _req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm> {
    throw new Error('createNoopIsm not supported on Sealevel');
  }

  async createMerkleTreeHook(
    _req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook> {
    throw new Error('createMerkleTreeHook not supported on Sealevel');
  }

  async createInterchainGasPaymasterHook(
    _req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook> {
    throw new Error(
      'createInterchainGasPaymasterHook not supported on Sealevel',
    );
  }

  async setInterchainGasPaymasterHookOwner(
    _req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner> {
    throw new Error(
      'setInterchainGasPaymasterHookOwner not supported on Sealevel',
    );
  }

  async setDestinationGasConfig(
    _req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig> {
    throw new Error('setDestinationGasConfig not supported on Sealevel');
  }

  async removeDestinationGasConfig(
    _req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig> {
    throw new Error('removeDestinationGasConfig not supported on Sealevel');
  }

  async createNoopHook(
    _req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook> {
    throw new Error('createNoopHook not supported on Sealevel');
  }

  async createValidatorAnnounce(
    _req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce> {
    throw new Error('createValidatorAnnounce not supported on Sealevel');
  }

  async createProxyAdmin(
    _req: Omit<AltVM.ReqCreateProxyAdmin, 'signer'>,
  ): Promise<AltVM.ResCreateProxyAdmin> {
    throw new Error('createProxyAdmin not supported on Sealevel');
  }

  async setProxyAdminOwner(
    _req: Omit<AltVM.ReqSetProxyAdminOwner, 'signer'>,
  ): Promise<AltVM.ResSetProxyAdminOwner> {
    throw new Error('setProxyAdminOwner not supported on Sealevel');
  }

  // ### TX WARP ###

  async createNativeToken(
    _req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken> {
    throw new Error(
      'createNativeToken not supported on Sealevel, use the Artifact API instead',
    );
  }

  async createCollateralToken(
    _req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken> {
    throw new Error(
      'createCollateralToken not supported on Sealevel, use the Artifact API instead',
    );
  }

  async createSyntheticToken(
    _req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken> {
    throw new Error(
      'createSyntheticToken not supported on Sealevel, use the Artifact API instead',
    );
  }

  async setTokenOwner(
    _req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner> {
    throw new Error(
      'setTokenOwner not supported on Sealevel, use the Artifact API instead',
    );
  }

  async setTokenIsm(
    _req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm> {
    throw new Error(
      'setTokenIsm not supported on Sealevel, use the Artifact API instead',
    );
  }

  async setTokenHook(
    _req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook> {
    throw new Error(
      'setTokenHook not supported on Sealevel, use the Artifact API instead',
    );
  }

  async enrollRemoteRouter(
    _req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter> {
    throw new Error(
      'enrollRemoteRouter not supported on Sealevel, use the Artifact API instead',
    );
  }

  async unenrollRemoteRouter(
    _req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter> {
    throw new Error(
      'unenrollRemoteRouter not supported on Sealevel, use the Artifact API instead',
    );
  }

  async transfer(
    _req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer> {
    throw new Error(
      'transfer not supported on Sealevel, use the Artifact API instead',
    );
  }

  async remoteTransfer(
    _req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer> {
    throw new Error(
      'remoteTransfer not supported on Sealevel, use the Artifact API instead',
    );
  }
}
