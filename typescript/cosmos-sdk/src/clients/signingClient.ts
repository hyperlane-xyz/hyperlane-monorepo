import {
  AccountData,
  EncodeObject,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import {
  AminoTypes,
  DeliverTxResponse,
  HttpEndpoint,
  QueryClient,
  SigningStargateClient,
  SigningStargateClientOptions,
  StdFee,
  assertIsDeliverTxSuccess,
  setupBankExtension,
} from '@cosmjs/stargate';
import { CometClient, connectComet } from '@cosmjs/tendermint-rpc';

import { coreTx, isTx, pdTx, warpTx } from '@hyperlane-xyz/cosmos-types';

import {
  MsgCreateMailboxEncodeObject,
  MsgProcessMessageEncodeObject,
  MsgSetMailboxEncodeObject,
} from '../hyperlane/core/messages.js';
import { setupCoreExtension } from '../hyperlane/core/query.js';
import {
  MsgAnnounceValidatorEncodeObject,
  MsgCreateMerkleRootMultisigIsmEncodeObject,
  MsgCreateMessageIdMultisigIsmEncodeObject,
  MsgCreateNoopIsmEncodeObject,
} from '../hyperlane/interchain_security/messages.js';
import { setupInterchainSecurityExtension } from '../hyperlane/interchain_security/query.js';
import {
  MsgClaimEncodeObject,
  MsgCreateIgpEncodeObject,
  MsgCreateMerkleTreeHookEncodeObject,
  MsgCreateNoopHookEncodeObject,
  MsgPayForGasEncodeObject,
  MsgSetDestinationGasConfigEncodeObject,
  MsgSetIgpOwnerEncodeObject,
} from '../hyperlane/post_dispatch/messages.js';
import { setupPostDispatchExtension } from '../hyperlane/post_dispatch/query.js';
import {
  MsgCreateCollateralTokenEncodeObject,
  MsgCreateSyntheticTokenEncodeObject,
  MsgEnrollRemoteRouterEncodeObject,
  MsgRemoteTransferEncodeObject,
  MsgSetTokenEncodeObject,
  MsgUnrollRemoteRouterEncodeObject,
} from '../hyperlane/warp/messages.js';
import { setupWarpExtension } from '../hyperlane/warp/query.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';

import { HyperlaneQueryClient } from './client.js';

type TxOptions = {
  fee?: StdFee | 'auto' | number;
  memo?: string;
};

export interface TxResponse<R> extends DeliverTxResponse {
  response: R;
}

export class SigningHyperlaneModuleClient extends SigningStargateClient {
  public query: HyperlaneQueryClient;
  public account: AccountData;
  public readonly GAS_MULTIPLIER = 1.6;

  protected constructor(
    cometClient: CometClient,
    signer: OfflineSigner,
    account: AccountData,
    options: SigningStargateClientOptions,
  ) {
    // register all the custom amino tx types
    const aminoTypes = Object.values(R)
      .filter((r) => !!r.amino?.type) // filter out tx responses which have no amino type
      .reduce(
        (types, { proto, amino }) => ({
          ...types,
          [proto.type]: {
            aminoType: amino?.type,
            toAmino: amino?.converter?.toJSON ?? proto.converter.toJSON,
            fromAmino: amino?.converter?.fromJSON ?? proto.converter.fromJSON,
          },
        }),
        {},
      );

    super(cometClient, signer, {
      ...options,
      aminoTypes: new AminoTypes({
        ...options.aminoTypes,
        ...aminoTypes,
      }),
    });

    this.query = QueryClient.withExtensions(
      cometClient,
      setupBankExtension,
      setupCoreExtension,
      setupInterchainSecurityExtension,
      setupPostDispatchExtension,
      setupWarpExtension,
    );

    // register all the custom tx types
    Object.values(R).forEach(({ proto }) => {
      this.registry.register(proto.type, proto.converter);
    });

    this.account = account;
  }

  static async connectWithSigner(
    endpoint: string | HttpEndpoint,
    signer: OfflineSigner,
    options: SigningStargateClientOptions = {},
  ): Promise<SigningHyperlaneModuleClient> {
    const client = await connectComet(endpoint);
    const [account] = await signer.getAccounts();
    return new SigningHyperlaneModuleClient(client, signer, account, options);
  }

  static async createWithSigner(
    cometclient: CometClient,
    signer: OfflineSigner,
    options: SigningStargateClientOptions = {},
  ): Promise<SigningHyperlaneModuleClient> {
    const [account] = await signer.getAccounts();
    return new SigningHyperlaneModuleClient(
      cometclient,
      signer,
      account,
      options,
    );
  }

  private async submitTx<T>(
    msg: EncodeObject,
    options?: TxOptions,
  ): Promise<TxResponse<T>> {
    const result = await this.signAndBroadcast(
      this.account.address,
      [msg],
      options?.fee ?? this.GAS_MULTIPLIER,
      options?.memo,
    );
    assertIsDeliverTxSuccess(result);

    return {
      ...result,
      response: this.registry.decode(result.msgResponses[0]),
    };
  }

  public async createMailbox(
    value: Omit<coreTx.MsgCreateMailbox, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<coreTx.MsgCreateMailboxResponse>> {
    const msg: MsgCreateMailboxEncodeObject = {
      typeUrl: R.MsgCreateMailbox.proto.type,
      value: R.MsgCreateMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setMailbox(
    value: Omit<coreTx.MsgSetMailbox, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<coreTx.MsgSetMailboxResponse>> {
    const msg: MsgSetMailboxEncodeObject = {
      typeUrl: R.MsgSetMailbox.proto.type,
      value: R.MsgSetMailbox.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async processMessage(
    value: Omit<coreTx.MsgProcessMessage, 'relayer'>,
    options?: TxOptions,
  ): Promise<TxResponse<coreTx.MsgProcessMessageResponse>> {
    const msg: MsgProcessMessageEncodeObject = {
      typeUrl: R.MsgProcessMessage.proto.type,
      value: R.MsgProcessMessage.proto.converter.create({
        ...value,
        relayer: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createMessageIdMultisigIsm(
    value: Omit<isTx.MsgCreateMessageIdMultisigIsm, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgCreateMessageIdMultisigIsmResponse>> {
    const msg: MsgCreateMessageIdMultisigIsmEncodeObject = {
      typeUrl: R.MsgCreateMessageIdMultisigIsm.proto.type,
      value: R.MsgCreateMessageIdMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createMerkleRootMultisigIsm(
    value: Omit<isTx.MsgCreateMerkleRootMultisigIsm, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgCreateMerkleRootMultisigIsmResponse>> {
    const msg: MsgCreateMerkleRootMultisigIsmEncodeObject = {
      typeUrl: R.MsgCreateMerkleRootMultisigIsm.proto.type,
      value: R.MsgCreateMerkleRootMultisigIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createNoopIsm(
    value: Omit<isTx.MsgCreateNoopIsm, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgCreateNoopIsmResponse>> {
    const msg: MsgCreateNoopIsmEncodeObject = {
      typeUrl: R.MsgCreateNoopIsm.proto.type,
      value: R.MsgCreateNoopIsm.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async announceValidator(
    value: Omit<isTx.MsgAnnounceValidator, 'creator'>,
    options?: TxOptions,
  ): Promise<TxResponse<isTx.MsgAnnounceValidatorResponse>> {
    const msg: MsgAnnounceValidatorEncodeObject = {
      typeUrl: R.MsgAnnounceValidator.proto.type,
      value: R.MsgAnnounceValidator.proto.converter.create({
        ...value,
        creator: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createIgp(
    value: Omit<pdTx.MsgCreateIgp, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgCreateIgpResponse>> {
    const msg: MsgCreateIgpEncodeObject = {
      typeUrl: R.MsgCreateIgp.proto.type,
      value: R.MsgCreateIgp.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setIgpOwner(
    value: Omit<pdTx.MsgSetIgpOwner, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgSetIgpOwnerResponse>> {
    const msg: MsgSetIgpOwnerEncodeObject = {
      typeUrl: R.MsgSetIgpOwner.proto.type,
      value: R.MsgSetIgpOwner.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setDestinationGasConfig(
    value: Omit<pdTx.MsgSetDestinationGasConfig, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgSetDestinationGasConfigResponse>> {
    const msg: MsgSetDestinationGasConfigEncodeObject = {
      typeUrl: R.MsgSetDestinationGasConfig.proto.type,
      value: R.MsgSetDestinationGasConfig.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async payForGas(
    value: Omit<pdTx.MsgPayForGas, 'sender'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgPayForGasResponse>> {
    const msg: MsgPayForGasEncodeObject = {
      typeUrl: R.MsgPayForGas.proto.type,
      value: R.MsgPayForGas.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async claim(
    value: Omit<pdTx.MsgClaim, 'sender'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgClaimResponse>> {
    const msg: MsgClaimEncodeObject = {
      typeUrl: R.MsgClaim.proto.type,
      value: R.MsgClaim.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createMerkleTreeHook(
    value: Omit<pdTx.MsgCreateMerkleTreeHook, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgCreateMerkleTreeHookResponse>> {
    const msg: MsgCreateMerkleTreeHookEncodeObject = {
      typeUrl: R.MsgCreateMerkleTreeHook.proto.type,
      value: R.MsgCreateMerkleTreeHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createNoopHook(
    value: Omit<pdTx.MsgCreateNoopHook, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<pdTx.MsgCreateNoopHookResponse>> {
    const msg: MsgCreateNoopHookEncodeObject = {
      typeUrl: R.MsgCreateNoopHook.proto.type,
      value: R.MsgCreateNoopHook.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createCollateralToken(
    value: Omit<warpTx.MsgCreateCollateralToken, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgCreateCollateralTokenResponse>> {
    const msg: MsgCreateCollateralTokenEncodeObject = {
      typeUrl: R.MsgCreateCollateralToken.proto.type,
      value: R.MsgCreateCollateralToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async createSyntheticToken(
    value: Omit<warpTx.MsgCreateSyntheticToken, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgCreateSyntheticTokenResponse>> {
    const msg: MsgCreateSyntheticTokenEncodeObject = {
      typeUrl: R.MsgCreateSyntheticToken.proto.type,
      value: R.MsgCreateSyntheticToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async setToken(
    value: Omit<warpTx.MsgSetToken, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgSetTokenResponse>> {
    const msg: MsgSetTokenEncodeObject = {
      typeUrl: R.MsgSetToken.proto.type,
      value: R.MsgSetToken.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async enrollRemoteRouter(
    value: Omit<warpTx.MsgEnrollRemoteRouter, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgEnrollRemoteRouterResponse>> {
    const msg: MsgEnrollRemoteRouterEncodeObject = {
      typeUrl: R.MsgEnrollRemoteRouter.proto.type,
      value: R.MsgEnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async unrollRemoteRouter(
    value: Omit<warpTx.MsgUnrollRemoteRouter, 'owner'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgUnrollRemoteRouterResponse>> {
    const msg: MsgUnrollRemoteRouterEncodeObject = {
      typeUrl: R.MsgUnrollRemoteRouter.proto.type,
      value: R.MsgUnrollRemoteRouter.proto.converter.create({
        ...value,
        owner: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }

  public async remoteTransfer(
    value: Omit<warpTx.MsgRemoteTransfer, 'sender'>,
    options?: TxOptions,
  ): Promise<TxResponse<warpTx.MsgRemoteTransferResponse>> {
    const msg: MsgRemoteTransferEncodeObject = {
      typeUrl: R.MsgRemoteTransfer.proto.type,
      value: R.MsgRemoteTransfer.proto.converter.create({
        ...value,
        sender: this.account.address,
      }),
    };

    return this.submitTx(msg, options);
  }
}
