import * as AltVM from '../altvm.js';

import { MockProvider } from './AltVMMockProvider.js';

type MockTransaction = any;
type MockReceipt = any;

export class MockSigner
  extends MockProvider
  implements AltVM.ISigner<MockTransaction, MockReceipt>
{
  static async connectWithSigner(): Promise<
    AltVM.ISigner<MockTransaction, MockReceipt>
  > {
    return new MockSigner();
  }

  getSignerAddress(): string {
    throw new Error(`not implemented`);
  }

  supportsTransactionBatching(): boolean {
    throw new Error(`not implemented`);
  }

  transactionToPrintableJson(_transaction: MockTransaction): Promise<object> {
    throw new Error(`not implemented`);
  }

  async sendAndConfirmTransaction(
    _transaction: MockTransaction,
  ): Promise<MockReceipt> {
    throw new Error(`not implemented`);
  }

  async sendAndConfirmBatchTransactions(
    _transactions: MockTransaction[],
  ): Promise<MockReceipt> {
    throw new Error(`not implemented`);
  }

  // ### TX CORE ###

  async createMailbox(
    _req: Omit<AltVM.ReqCreateMailbox, 'signer'>,
  ): Promise<AltVM.ResCreateMailbox<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setDefaultIsm(
    _req: Omit<AltVM.ReqSetDefaultIsm, 'signer'>,
  ): Promise<AltVM.ResSetDefaultIsm<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setDefaultHook(
    _req: Omit<AltVM.ReqSetDefaultHook, 'signer'>,
  ): Promise<AltVM.ResSetDefaultHook<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setRequiredHook(
    _req: Omit<AltVM.ReqSetRequiredHook, 'signer'>,
  ): Promise<AltVM.ResSetRequiredHook<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setMailboxOwner(
    _req: Omit<AltVM.ReqSetMailboxOwner, 'signer'>,
  ): Promise<AltVM.ResSetMailboxOwner<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createMerkleRootMultisigIsm(
    _req: Omit<AltVM.ReqCreateMerkleRootMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleRootMultisigIsm<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createMessageIdMultisigIsm(
    _req: Omit<AltVM.ReqCreateMessageIdMultisigIsm, 'signer'>,
  ): Promise<AltVM.ResCreateMessageIdMultisigIsm<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createRoutingIsm(
    _req: Omit<AltVM.ReqCreateRoutingIsm, 'signer'>,
  ): Promise<AltVM.ResCreateRoutingIsm<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setRoutingIsmRoute(
    _req: Omit<AltVM.ReqSetRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmRoute<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async removeRoutingIsmRoute(
    _req: Omit<AltVM.ReqRemoveRoutingIsmRoute, 'signer'>,
  ): Promise<AltVM.ResRemoveRoutingIsmRoute<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setRoutingIsmOwner(
    _req: Omit<AltVM.ReqSetRoutingIsmOwner, 'signer'>,
  ): Promise<AltVM.ResSetRoutingIsmOwner<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createNoopIsm(
    _req: Omit<AltVM.ReqCreateNoopIsm, 'signer'>,
  ): Promise<AltVM.ResCreateNoopIsm<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createMerkleTreeHook(
    _req: Omit<AltVM.ReqCreateMerkleTreeHook, 'signer'>,
  ): Promise<AltVM.ResCreateMerkleTreeHook<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createInterchainGasPaymasterHook(
    _req: Omit<AltVM.ReqCreateInterchainGasPaymasterHook, 'signer'>,
  ): Promise<AltVM.ResCreateInterchainGasPaymasterHook<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setInterchainGasPaymasterHookOwner(
    _req: Omit<AltVM.ReqSetInterchainGasPaymasterHookOwner, 'signer'>,
  ): Promise<AltVM.ResSetInterchainGasPaymasterHookOwner<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setDestinationGasConfig(
    _req: Omit<AltVM.ReqSetDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResSetDestinationGasConfig<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async removeDestinationGasConfig(
    _req: Omit<AltVM.ReqRemoveDestinationGasConfig, 'signer'>,
  ): Promise<AltVM.ResRemoveDestinationGasConfig<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createNoopHook(
    _req: Omit<AltVM.ReqCreateNoopHook, 'signer'>,
  ): Promise<AltVM.ResCreateNoopHook<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createValidatorAnnounce(
    _req: Omit<AltVM.ReqCreateValidatorAnnounce, 'signer'>,
  ): Promise<AltVM.ResCreateValidatorAnnounce<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  // ### TX WARP ###

  async createNativeToken(
    _req: Omit<AltVM.ReqCreateNativeToken, 'signer'>,
  ): Promise<AltVM.ResCreateNativeToken<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createCollateralToken(
    _req: Omit<AltVM.ReqCreateCollateralToken, 'signer'>,
  ): Promise<AltVM.ResCreateCollateralToken<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async createSyntheticToken(
    _req: Omit<AltVM.ReqCreateSyntheticToken, 'signer'>,
  ): Promise<AltVM.ResCreateSyntheticToken<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setTokenOwner(
    _req: Omit<AltVM.ReqSetTokenOwner, 'signer'>,
  ): Promise<AltVM.ResSetTokenOwner<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setTokenIsm(
    _req: Omit<AltVM.ReqSetTokenIsm, 'signer'>,
  ): Promise<AltVM.ResSetTokenIsm<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async setTokenHook(
    _req: Omit<AltVM.ReqSetTokenHook, 'signer'>,
  ): Promise<AltVM.ResSetTokenHook<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async enrollRemoteRouter(
    _req: Omit<AltVM.ReqEnrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResEnrollRemoteRouter<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async unenrollRemoteRouter(
    _req: Omit<AltVM.ReqUnenrollRemoteRouter, 'signer'>,
  ): Promise<AltVM.ResUnenrollRemoteRouter<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async transfer(
    _req: Omit<AltVM.ReqTransfer, 'signer'>,
  ): Promise<AltVM.ResTransfer<MockReceipt>> {
    throw new Error(`not implemented`);
  }

  async remoteTransfer(
    _req: Omit<AltVM.ReqRemoteTransfer, 'signer'>,
  ): Promise<AltVM.ResRemoteTransfer<MockReceipt>> {
    throw new Error(`not implemented`);
  }
}
