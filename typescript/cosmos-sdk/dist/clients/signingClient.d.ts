import { AccountData, OfflineSigner } from '@cosmjs/proto-signing';
import {
  DeliverTxResponse,
  HttpEndpoint,
  SigningStargateClient,
  SigningStargateClientOptions,
  StdFee,
} from '@cosmjs/stargate';
import { CometClient } from '@cosmjs/tendermint-rpc';

import { coreTx, isTx, pdTx, warpTx } from '@hyperlane-xyz/cosmos-types';

import { HyperlaneQueryClient } from './client.js';

type TxOptions = {
  fee?: StdFee | 'auto' | number;
  memo?: string;
};
export interface TxResponse<R> extends DeliverTxResponse {
  response: R;
}
export declare class SigningHyperlaneModuleClient extends SigningStargateClient {
  query: HyperlaneQueryClient;
  account: AccountData;
  readonly GAS_MULTIPLIER = 1.6;
  protected constructor(
    cometClient: CometClient,
    signer: OfflineSigner,
    account: AccountData,
    options: SigningStargateClientOptions,
  );
  static connectWithSigner(
    endpoint: string | HttpEndpoint,
    signer: OfflineSigner,
    options?: SigningStargateClientOptions,
  ): Promise<SigningHyperlaneModuleClient>;
  static createWithSigner(
    cometclient: CometClient,
    signer: OfflineSigner,
    options?: SigningStargateClientOptions,
  ): Promise<SigningHyperlaneModuleClient>;
  private submitTx;
  createMailbox(
    value: Omit<coreTx.MsgCreateMailbox, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<coreTx.MsgCreateMailboxResponse>>;
  setMailbox(
    value: Omit<coreTx.MsgSetMailbox, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<coreTx.MsgSetMailboxResponse>>;
  processMessage(
    value: Omit<coreTx.MsgProcessMessage, 'relayer'>,
    options?: TxOptions,
  ): Promise<TxResponse<coreTx.MsgProcessMessageResponse>>;
  createMessageIdMultisigIsm(
    value: Omit<isTx.MsgCreateMessageIdMultisigIsm, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgCreateMessageIdMultisigIsmResponse>>;
  createMerkleRootMultisigIsm(
    value: Omit<isTx.MsgCreateMerkleRootMultisigIsm, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgCreateMerkleRootMultisigIsmResponse>>;
  createNoopIsm(
    value: Omit<isTx.MsgCreateNoopIsm, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgCreateNoopIsmResponse>>;
  announceValidator(
    value: Omit<isTx.MsgAnnounceValidator, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgAnnounceValidatorResponse>>;
  createIgp(
    value: Omit<pdTx.MsgCreateIgp, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgCreateIgpResponse>>;
  setIgpOwner(
    value: Omit<pdTx.MsgSetIgpOwner, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgSetIgpOwnerResponse>>;
  setDestinationGasConfig(
    value: Omit<pdTx.MsgSetDestinationGasConfig, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgSetDestinationGasConfigResponse>>;
  payForGas(
    value: Omit<pdTx.MsgPayForGas, 'sender'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgPayForGasResponse>>;
  claim(
    value: Omit<pdTx.MsgClaim, 'sender'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgClaimResponse>>;
  createMerkleTreeHook(
    value: Omit<pdTx.MsgCreateMerkleTreeHook, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgCreateMerkleTreeHookResponse>>;
  createNoopHook(
    value: Omit<pdTx.MsgCreateNoopHook, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgCreateNoopHookResponse>>;
  createCollateralToken(
    value: Omit<warpTx.MsgCreateCollateralToken, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgCreateCollateralTokenResponse>>;
  createSyntheticToken(
    value: Omit<warpTx.MsgCreateSyntheticToken, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgCreateSyntheticTokenResponse>>;
  setToken(
    value: Omit<warpTx.MsgSetToken, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgSetTokenResponse>>;
  enrollRemoteRouter(
    value: Omit<warpTx.MsgEnrollRemoteRouter, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgEnrollRemoteRouterResponse>>;
  unrollRemoteRouter(
    value: Omit<warpTx.MsgUnrollRemoteRouter, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgUnrollRemoteRouterResponse>>;
  remoteTransfer(
    value: Omit<warpTx.MsgRemoteTransfer, 'sender'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgRemoteTransferResponse>>;
}
export {};
//# sourceMappingURL=signingClient.d.ts.map
