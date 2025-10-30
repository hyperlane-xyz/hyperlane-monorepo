import { Account, AleoNetworkClient, ProgramManager } from '@provablehq/sdk';

import { AltVM, assert } from '@hyperlane-xyz/utils';

import { AleoTransaction } from '../utils/types.js';

export class AleoProvider implements AltVM.IProvider {
  protected readonly aleoClient: AleoNetworkClient;
  protected readonly rpcUrls: string[];

  static async connect(
    rpcUrls: string[],
    _chainId: string | number,
  ): Promise<AleoProvider> {
    return new AleoProvider(rpcUrls);
  }

  protected constructor(rpcUrls: string[]) {
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    this.rpcUrls = rpcUrls;
    this.aleoClient = new AleoNetworkClient(rpcUrls[0]);
  }

  // ### QUERY BASE ###

  async isHealthy() {
    const latestBlockHeight = await this.aleoClient.getLatestHeight();
    return latestBlockHeight > 0;
  }

  getRpcUrls(): string[] {
    return this.rpcUrls;
  }

  async getHeight() {
    return this.aleoClient.getLatestHeight();
  }

  async getBalance(req: AltVM.ReqGetBalance): Promise<bigint> {
    const balance = await this.aleoClient.getPublicBalance(req.address);
    return BigInt(balance);
  }

  async getTotalSupply(_req: AltVM.ReqGetTotalSupply): Promise<bigint> {
    throw new Error(`TODO: implement`);
  }

  async estimateTransactionFee(
    req: AltVM.ReqEstimateTransactionFee<AleoTransaction>,
  ): Promise<AltVM.ResEstimateTransactionFee> {
    const programManager = new ProgramManager(this.rpcUrls[0]);
    programManager.setAccount(new Account());

    const tx = await programManager.buildExecutionTransaction(req.transaction);

    return {
      fee: tx.feeAmount(),
      gasUnits: 0n,
      gasPrice: 0,
    };
  }

  // ### QUERY CORE ###

  async getMailbox(_req: AltVM.ReqGetMailbox): Promise<AltVM.ResGetMailbox> {
    throw new Error(`TODO: implement`);
  }

  async isMessageDelivered(
    _req: AltVM.ReqIsMessageDelivered,
  ): Promise<boolean> {
    throw new Error(`TODO: implement`);
  }

  async getIsmType(_req: AltVM.ReqGetIsmType): Promise<AltVM.IsmType> {
    throw new Error(`TODO: implement`);
  }

  async getMessageIdMultisigIsm(
    _req: AltVM.ReqMessageIdMultisigIsm,
  ): Promise<AltVM.ResMessageIdMultisigIsm> {
    throw new Error(`TODO: implement`);
  }

  async getMerkleRootMultisigIsm(
    _req: AltVM.ReqMerkleRootMultisigIsm,
  ): Promise<AltVM.ResMerkleRootMultisigIsm> {
    throw new Error(`TODO: implement`);
  }

  async getRoutingIsm(_req: AltVM.ReqRoutingIsm): Promise<AltVM.ResRoutingIsm> {
    throw new Error(`TODO: implement`);
  }

  async getNoopIsm(_req: AltVM.ReqNoopIsm): Promise<AltVM.ResNoopIsm> {
    throw new Error(`TODO: implement`);
  }

  async getHookType(_req: AltVM.ReqGetHookType): Promise<AltVM.HookType> {
    throw new Error(`TODO: implement`);
  }

  async getInterchainGasPaymasterHook(
    _req: AltVM.ReqGetInterchainGasPaymasterHook,
  ): Promise<AltVM.ResGetInterchainGasPaymasterHook> {
    throw new Error(`TODO: implement`);
  }

  async getMerkleTreeHook(
    _req: AltVM.ReqGetMerkleTreeHook,
  ): Promise<AltVM.ResGetMerkleTreeHook> {
    throw new Error(`TODO: implement`);
  }

  // ### QUERY WARP ###

  async getToken(_req: AltVM.ReqGetToken): Promise<AltVM.ResGetToken> {
    throw new Error(`TODO: implement`);
  }

  async getRemoteRouters(
    _req: AltVM.ReqGetRemoteRouters,
  ): Promise<AltVM.ResGetRemoteRouters> {
    throw new Error(`TODO: implement`);
  }

  async getBridgedSupply(_req: AltVM.ReqGetBridgedSupply): Promise<bigint> {
    throw new Error(`TODO: implement`);
  }

  async quoteRemoteTransfer(
    _req: AltVM.ReqQuoteRemoteTransfer,
  ): Promise<AltVM.ResQuoteRemoteTransfer> {
    throw new Error(`TODO: implement`);
  }

  // ### GET CORE TXS ###

  async getCreateMailboxTransaction(
    _req: AltVM.ReqCreateMailbox,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetDefaultIsmTransaction(
    _req: AltVM.ReqSetDefaultIsm,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetDefaultHookTransaction(
    _req: AltVM.ReqSetDefaultHook,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetRequiredHookTransaction(
    _req: AltVM.ReqSetRequiredHook,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetMailboxOwnerTransaction(
    _req: AltVM.ReqSetMailboxOwner,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateMerkleRootMultisigIsmTransaction(
    _req: AltVM.ReqCreateMerkleRootMultisigIsm,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateMessageIdMultisigIsmTransaction(
    _req: AltVM.ReqCreateMessageIdMultisigIsm,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateRoutingIsmTransaction(
    _req: AltVM.ReqCreateRoutingIsm,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetRoutingIsmRouteTransaction(
    _req: AltVM.ReqSetRoutingIsmRoute,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getRemoveRoutingIsmRouteTransaction(
    _req: AltVM.ReqRemoveRoutingIsmRoute,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetRoutingIsmOwnerTransaction(
    _req: AltVM.ReqSetRoutingIsmOwner,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateNoopIsmTransaction(
    _req: AltVM.ReqCreateNoopIsm,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateMerkleTreeHookTransaction(
    _req: AltVM.ReqCreateMerkleTreeHook,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateInterchainGasPaymasterHookTransaction(
    _req: AltVM.ReqCreateInterchainGasPaymasterHook,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetInterchainGasPaymasterHookOwnerTransaction(
    _req: AltVM.ReqSetInterchainGasPaymasterHookOwner,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetDestinationGasConfigTransaction(
    _req: AltVM.ReqSetDestinationGasConfig,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateValidatorAnnounceTransaction(
    _req: AltVM.ReqCreateValidatorAnnounce,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  // ### GET WARP TXS ###

  async getCreateCollateralTokenTransaction(
    _req: AltVM.ReqCreateCollateralToken,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getCreateSyntheticTokenTransaction(
    _req: AltVM.ReqCreateSyntheticToken,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetTokenOwnerTransaction(
    _req: AltVM.ReqSetTokenOwner,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getSetTokenIsmTransaction(
    _req: AltVM.ReqSetTokenIsm,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getEnrollRemoteRouterTransaction(
    _req: AltVM.ReqEnrollRemoteRouter,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getUnenrollRemoteRouterTransaction(
    _req: AltVM.ReqUnenrollRemoteRouter,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }

  async getTransferTransaction(
    req: AltVM.ReqTransfer,
  ): Promise<AleoTransaction> {
    return {
      programName: 'credits.aleo',
      functionName: 'transfer_public',
      priorityFee: 0,
      privateFee: false,
      inputs: [req.recipient, `${req.amount}u64`],
    };
  }

  async getRemoteTransferTransaction(
    _req: AltVM.ReqRemoteTransfer,
  ): Promise<AleoTransaction> {
    throw new Error(`TODO: implement`);
  }
}
