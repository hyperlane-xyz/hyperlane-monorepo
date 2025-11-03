import * as AltVM from '../altvm.js';

type MockTransaction = any;

export class MockProvider implements AltVM.IProvider {
  static async connect(): Promise<MockProvider> {
    return new MockProvider();
  }

  // ### QUERY BASE ###

  async isHealthy(): Promise<boolean> {
    throw new Error(`not implemented`);
  }

  getRpcUrls(): string[] {
    throw new Error(`not implemented`);
  }

  async getHeight(): Promise<number> {
    throw new Error(`not implemented`);
  }

  async getBalance(_req: AltVM.ReqGetBalance): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async getTotalSupply(_req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async estimateTransactionFee(
    _req: AltVM.ReqEstimateTransactionFee<MockTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    throw new Error(`not implemented`);
  }

  // ### QUERY CORE ###

  async getMailbox(_req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    throw new Error(`not implemented`);
  }

  async isMessageDelivered(
    _req: AltVM.ReqIsMessageDelivered,
  ): Promise<boolean> {
    throw new Error(`not implemented`);
  }

  async getIsmType(_req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    throw new Error(`not implemented`);
  }

  async getMessageIdMultisigIsm(
    _req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    throw new Error(`not implemented`);
  }

  async getMerkleRootMultisigIsm(
    _req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    throw new Error(`not implemented`);
  }

  async getRoutingIsm(_req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    throw new Error(`not implemented`);
  }

  async getNoopIsm(_req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    throw new Error(`not implemented`);
  }

  async getHookType(_req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    throw new Error(`not implemented`);
  }

  async getInterchainGasPaymasterHook(
    _req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    throw new Error(`not implemented`);
  }

  async getMerkleTreeHook(
    _req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    throw new Error(`not implemented`);
  }

  async getNoopHook(_req: AltVM.ReqGetNoopHook): Promise<AltVM.ResGetNoopHook> {
    throw new Error(`not implemented`);
  }

  // ### QUERY WARP ###

  async getToken(_req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    throw new Error(`not implemented`);
  }

  async getRemoteRouters(
    _req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    throw new Error(`not implemented`);
  }

  async getBridgedSupply(_req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    throw new Error(`not implemented`);
  }

  async quoteRemoteTransfer(
    _req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    throw new Error(`not implemented`);
  }

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    _req: AltVM.ReqCreateMailbox,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetDefaultIsmTransaction(
    _req: AltVM.ReqSetDefaultIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetDefaultHookTransaction(
    _req: AltVM.ReqSetDefaultHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRequiredHookTransaction(
    _req: AltVM.ReqSetRequiredHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetMailboxOwnerTransaction(
    _req: AltVM.ReqSetMailboxOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    _req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateMessageIdMultisigIsmTransaction(
    _req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateRoutingIsmTransaction(
    _req: AltVM.ReqCreateRoutingIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRoutingIsmRouteTransaction(
    _req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoveRoutingIsmRouteTransaction(
    _req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetRoutingIsmOwnerTransaction(
    _req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateNoopIsmTransaction(
    _req: AltVM.ReqCreateNoopIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateMerkleTreeHookTransaction(
    _req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    _req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    _req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetDestinationGasConfigTransaction(
    _req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoveDestinationGasConfigTransaction(
    _req: AltVM.ReqRemoveDestinationGasConfig,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateNoopHookTransaction(
    _req: AltVM.ReqCreateNoopHook,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateValidatorAnnounceTransaction(
    _req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  // ### GET WARP TXS ###

  async getCreateNativeTokenTransaction(
    _req: AltVM.ReqCreateNativeToken,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateCollateralTokenTransaction(
    _req: AltVM.ReqCreateCollateralToken,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getCreateSyntheticTokenTransaction(
    _req: AltVM.ReqCreateSyntheticToken,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenOwnerTransaction(
    _req: AltVM.ReqSetTokenOwner,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getSetTokenIsmTransaction(
    _req: AltVM.ReqSetTokenIsm,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getEnrollRemoteRouterTransaction(
    _req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getUnenrollRemoteRouterTransaction(
    _req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getTransferTransaction(
    _req: AltVM.ReqTransfer,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }

  async getRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
  ): Promise<MockTransaction> {
    throw new Error(`not implemented`);
  }
}
